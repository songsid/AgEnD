/**
 * #1665 (design: the comment on #1665): the host-kept web preferences — the store (registry, per-key validation, own
 * keys, atomic file, unreadable file never overwritten, onlyIfUnset), the /ui/prefs routes (a session write with its
 * CSRF; never the public link, never a read-only session), the page carrying the host's values for a paint without a
 * flash, and the public link's sort-order write taken away. Real handlers and store, fake request/response, no fleet.
 */
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleWebRequest, serveAppShell } from "../src/web-api.js";
import { handleViewRequest } from "../src/view-api.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { OPERATOR, TEAM_GROUP_PREFIX, WebPrefsStore, WEB_PREF_KEYS, parseWebPrefsPatch } from "../src/web-prefs.js";

const token = "c".repeat(48), local = "http://127.0.0.1:19280", pub = "https://sample.trycloudflare.com", exposureId = "a".repeat(32);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "prefs-1665-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function request(path: string, method = "GET", headers: Record<string, string> = {}, host = "127.0.0.1:19280") {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host, ...headers } as Record<string, string>, destroy: vi.fn(), socket: { destroy: vi.fn() } });
  let status = 0, body = "";
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, headersSent: false, writableEnded: false,
    setHeader() {}, writeHead: (code: number) => { status = code; }, end: (text = "") => { body = String(text); }, write: () => true, destroy: vi.fn(),
  });
  return { req, res, status: () => status, json: () => JSON.parse(body), body: () => body,
    feed: (value: unknown) => { req.emit("data", Buffer.from(typeof value === "string" ? value : JSON.stringify(value))); req.emit("end"); } };
}
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

function setup(opts: { tier?: "admin" | "read"; publicLink?: boolean } = {}) {
  const sessions = new WebSessionStore();
  const s = sessions.create({ tier: opts.tier ?? "admin", surface: opts.publicLink ? "gateway" : "local", label: "t", tokenEpoch: tokenEpoch(token), ...(opts.publicLink ? { exposureId } : {}) });
  const prefs = new WebPrefsStore(tmp());
  const emitSseEvent = vi.fn();
  const ctx = { webToken: token, webSessions: sessions, webPrefs: prefs, logger: { info() {}, debug() {}, error() {}, warn() {} },
    sseClients: new Set(), getUiStatus: () => ({ instances: [], prefs_rev: prefs.rev() }), emitSseEvent } as any;
  // The public link: its own listener's request (bound, never a header), its __Host- cookie, its origin.
  const cookie = `${opts.publicLink ? "__Host-" : ""}agend_session=${s.sessionId}`;
  const origin = opts.publicLink ? pub : local, host = opts.publicLink ? "sample.trycloudflare.com" : "127.0.0.1:19280";
  const write = (body: unknown) => {
    const h = request("/ui/prefs", "POST", { cookie, origin, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" }, host);
    if (opts.publicLink) bindGatewayRequest(h.req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    const handled = handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), ctx);
    h.feed(body);
    return { handled, ...h };
  };
  const read = () => {
    const h = request("/ui/prefs", "GET", { cookie }, host);
    if (opts.publicLink) bindGatewayRequest(h.req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), ctx);
    return h;
  };
  return { prefs, ctx, write, read, emitSseEvent };
}

describe("the registry: each key validated on its own, unknown keys refused", () => {
  const VALID: Record<string, unknown> = {
    theme: "dark", lang: "zh-TW",
    ...Object.fromEntries(["fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"].map(k => [k, "a".repeat(32)])),
    "nav.order": [{ item_type: "group", item_name: "Ops", sort_index: 0, group_name: null }, { item_type: "instance", item_name: "alpha", sort_index: 0, group_name: "Ops" }],
    "nav.collapsed": ["Ops"], "nav.filter": { q: "rev", status: ["working"], cli: ["claude-code"] }, "nav.sort": { mode: "recent", favs: "fixed" },
    "nav.favorites": ["alpha"], "preview.optIn": true, "names.primary": "instance", "fx.show": false,
    "card.size": "l", "card.sizeByInstance": { alpha: "s", __proto__x: "m" }, "theme.pageByInstance": { alpha: "page", beta: "chat" },
    "color.show": ["name", "ring"], "color.off": true,
    "widget.sidebar": { spec: { v: 1, title: "Fleet", items: [{ type: "stat", label: "Idle", bind: "fleet.idle" }] }, data: {} },
  };
  const INVALID: Record<string, unknown[]> = {
    theme: ["blue", "", 1],
    ...Object.fromEntries(["fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"].map(k => [k, ["", "bad", true, {}, "a".repeat(31)]])),
    lang: ["fr", "zh", true],
    "nav.sort": ["recent", {}, { mode: "recent" }, { mode: "newest", favs: "fixed" }, { mode: "recent", favs: "pinned" }, { mode: "recent", favs: "fixed", extra: 1 }],
    "nav.order": ["x", [{ item_type: "group", item_name: "Ops", sort_index: 0 }], [{ item_type: "instance", item_name: "a", sort_index: -1, group_name: "G" }],
      [{ item_type: "group", item_name: "Ops", sort_index: 0, group_name: "G" }], [{ item_type: "panel", item_name: "a", sort_index: 0, group_name: null }],
      [{ item_type: "instance", item_name: "a", sort_index: 0, group_name: "G", extra: 1 }], Array.from({ length: 1001 }, (_, i) => ({ item_type: "group", item_name: `g${i}`, sort_index: i, group_name: null }))],
    "nav.collapsed": [["a", "a"], [""], ["x".repeat(129)], "Ops", [1]],
    "nav.filter": [{ q: "", status: [] }, { q: "x".repeat(201), status: [], cli: [] }, { q: "", status: ["busy"], cli: [] }, { q: "", status: [], cli: ["Bad Name"] }, []],
    "nav.favorites": [["alpha", "alpha"], "alpha", [""]],
    "preview.optIn": ["true", 1],
    "names.primary": ["display", "", true, ["instance"]],
    "fx.show": ["off", 0, "false"],
    "card.size": ["xl", "M", 1],
    "color.show": ["ring", ["ring", "ring"], ["glow"], [1], ["name", "bar", "ring", "name"]],
    "color.off": [false, "true", 1],
    "card.sizeByInstance": [[], { a: "xl" }, { "": "s" }, Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`n${i}`, "s"]))],
    "theme.pageByInstance": [[], "page", { a: "on" }, { a: true }, { "": "page" }, Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`n${i}`, "page"]))],
    "widget.sidebar": ["x", { spec: { v: 1, title: "x", items: [{ type: "stat", label: "Cost", bind: "cost_usd" }] }, data: {} }, { spec: { v: 1, title: "x", items: [] }, data: {} }],
  };
  it("covers every key the store knows", () => {
    expect([Object.keys(VALID).sort(), Object.keys(INVALID).sort()]).toEqual([[...WEB_PREF_KEYS].sort(), [...WEB_PREF_KEYS].sort()]);
  });
  it("a valid value for every key is accepted (all at once), and null clears", () => {
    const r = parseWebPrefsPatch({ ...VALID, theme: null }, (n) => n === "alpha");
    expect(r.ok && [...r.patch.entries()]).toEqual(Object.entries({ ...VALID, theme: null }));
  });
  it("an invalid value is refused, per key", () => {
    const accepted: string[] = [];
    for (const [key, values] of Object.entries(INVALID)) for (const v of values) {
      if (parseWebPrefsPatch({ [key]: v }, (n) => n === "alpha").ok) accepted.push(`${key}=${JSON.stringify(v).slice(0, 40)}`);
    }
    expect(accepted).toEqual([]);
  });
  it("the tour and the first-run card are not synced (the user's call): not keys of the store", () => {
    expect([parseWebPrefsPatch({ "seen.tour": true }).ok, parseWebPrefsPatch({ "seen.firstRun": true }).ok, WEB_PREF_KEYS.some((k) => k.startsWith("seen."))]).toEqual([false, false, false]);
  });
  it("unknown keys, __proto__ and constructor included, are refused — and refuse the whole request", () => {
    const outcomes = ['{"__proto__":"dark"}', '{"constructor":true}', '{"toString":1}', '{"themes":"dark"}', '{"theme":"dark","__proto__":{"x":1}}']
      .map((raw) => parseWebPrefsPatch(JSON.parse(raw)));
    expect(outcomes.map((o) => (o.ok ? "accepted" : o.error.split(":")[0]))).toEqual(["unknown_pref", "unknown_pref", "unknown_pref", "unknown_pref", "unknown_pref"]);
    expect([parseWebPrefsPatch({}).ok, parseWebPrefsPatch([]).ok, parseWebPrefsPatch(null).ok]).toEqual([false, false, false]);
  });
});

describe("the store: one operator bucket on disk", () => {
  it("writes atomically to <home>/web-prefs.json (0600), raises rev on a change only, and reads back after a restart", () => {
    const dir = tmp();
    const a = new WebPrefsStore(dir);
    const w1 = a.write(OPERATOR, new Map<string, unknown>([["theme", "dark"], ["preview.optIn", true]]));
    const w2 = a.write(OPERATOR, new Map<string, unknown>([["theme", "dark"]]));     // the same value: no change
    const w3 = a.write(OPERATOR, new Map<string, unknown>([["preview.optIn", null]]));   // cleared
    expect([w1.ok && w1.changed, w2.ok && w2.changed, w3.ok && w3.changed, a.rev()]).toEqual([["theme", "preview.optIn"], [], ["preview.optIn"], 2]);
    expect(statSync(join(dir, "web-prefs.json")).mode & 0o777).toBe(0o600);
    const b = new WebPrefsStore(dir);
    expect(b.read(OPERATOR)).toEqual({ values: { theme: "dark" }, rev: 2 });
  });
  it("onlyIfUnset takes only the keys the host does not have yet (a device's first upload)", () => {
    const s = new WebPrefsStore(tmp());
    s.write(OPERATOR, new Map([["theme", "light"]]));
    const r = s.write(OPERATOR, new Map<string, unknown>([["theme", "dark"], ["lang", "zh-TW"]]), { onlyIfUnset: true });
    expect([r.ok && r.changed, s.read().values]).toEqual([["lang"], { theme: "light", lang: "zh-TW" }]);
  });
  it("a file it cannot parse is never overwritten: defaults are read, writes are refused (503)", () => {
    const dir = tmp();
    writeFileSync(join(dir, "web-prefs.json"), "{ not json");
    const s = new WebPrefsStore(dir);
    const w = s.write(OPERATOR, new Map([["theme", "dark"]]));
    expect([s.read(), w, readFileSync(join(dir, "web-prefs.json"), "utf8")]).toEqual([{ values: {}, rev: 0, unreadable: true }, { ok: false, status: 503, error: "prefs_unreadable" }, "{ not json"]);
  });
  it("valid JSON of another shape or version is not ours to replace either", () => {
    const outcomes: unknown[] = [];
    for (const raw of ['{"version":2,"rev":1,"identities":{}}', '{"version":1,"rev":1,"identities":[]}', '[]', '{"version":1,"identities":{}}']) {
      const dir = tmp();
      writeFileSync(join(dir, "web-prefs.json"), raw);
      const s = new WebPrefsStore(dir);
      const w = s.write(OPERATOR, new Map([["theme", "dark"]]));
      outcomes.push([s.read().unreadable, w.ok, readFileSync(join(dir, "web-prefs.json"), "utf8") === raw]);
    }
    expect(outcomes).toEqual(Array(4).fill([true, false, true]));
  });
  it("a key or value from the file this version would refuse is never served", () => {
    const dir = tmp();
    writeFileSync(join(dir, "web-prefs.json"), JSON.stringify({ version: 1, rev: 4, identities: { operator: { values: { theme: "blue", lang: "en", "__proto__": "x", gone: 1 }, updated: {} } } }));
    expect(new WebPrefsStore(dir).read()).toEqual({ values: { lang: "en" }, rev: 4 });
  });
  it("no place for the file (a fleet with no data directory): defaults, nothing written, nothing thrown", () => {
    const s = new WebPrefsStore(undefined as unknown as string);
    expect([s.read(), s.rev(), s.write(OPERATOR, new Map([["theme", "dark"]]))]).toEqual([{ values: {}, rev: 0, unreadable: true }, 0, { ok: false, status: 503, error: "prefs_unreadable" }]);
  });
  it("only a file that is not there (ENOENT) is a new store: one this process may not read is never replaced (#1669 r1)", () => {
    const dir = tmp();
    const file = join(dir, "web-prefs.json");
    const original = JSON.stringify({ version: 1, rev: 7, identities: { operator: { values: { theme: "light", lang: "en" }, updated: {} } } });
    writeFileSync(file, original);
    chmodSync(file, 0o000);
    const s = new WebPrefsStore(dir);
    let refused: unknown;
    try { refused = [s.read(), s.write(OPERATOR, new Map([["theme", "dark"]]))]; } finally { chmodSync(file, 0o600); }
    expect([refused, readFileSync(file, "utf8")]).toEqual([[{ values: {}, rev: 0, unreadable: true }, { ok: false, status: 503, error: "prefs_unreadable" }], original]);
    // Readable again: the same store reads it now — and a write keeps what was there.
    s.write(OPERATOR, new Map([["lang", "zh-TW"]]));
    expect(new WebPrefsStore(dir).read()).toEqual({ values: { theme: "light", lang: "zh-TW" }, rev: 8 });
    // The control: no file at all is a new store.
    const fresh = new WebPrefsStore(tmp());
    expect([fresh.read(), fresh.write(OPERATOR, new Map([["theme", "dark"]])).ok]).toEqual([{ values: {}, rev: 0 }, true]);
  });
  it("a failed write leaves memory as the file is", () => {
    const s = new WebPrefsStore(tmp(), { write: () => { throw new Error("disk full"); } });
    expect(() => s.write(OPERATOR, new Map([["theme", "dark"]]))).toThrow("disk full");
    expect([s.read().values, s.rev()]).toEqual([{}, 0]);
  });
});

describe("/ui/prefs", () => {
  it("a signed-in session reads and writes; the change is announced in the next status frame", async () => {
    const t = setup();
    const w = t.write({ set: { theme: "dark", "nav.collapsed": ["Ops"] } });
    await flush();
    expect([w.status(), w.json()]).toEqual([200, { values: { theme: "dark", "nav.collapsed": ["Ops"] }, rev: 1, changed: ["theme", "nav.collapsed"], ownerScope: "operator", ownerEpoch: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    expect(t.emitSseEvent.mock.calls).toEqual([["status", { instances: [], prefs_rev: 1 }]]);
    const r = t.read();
    expect([r.status(), r.json()]).toEqual([200, { values: { theme: "dark", "nav.collapsed": ["Ops"] }, rev: 1, ownerScope: "operator", ownerEpoch: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
  });
  it("a session revoked, or the token rotated, while the body was on its way: nothing written, nothing announced (#1669 r1)", async () => {
    const outcomes: unknown[] = [];
    for (const change of ["none", "revoke", "rotate"] as const) {
      const t = setup();
      const sessions = t.ctx.webSessions as WebSessionStore;
      const s = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
      const h = request("/ui/prefs", "POST", { cookie: `agend_session=${s.sessionId}`, origin: local, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId) });
      handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), t.ctx);
      if (change === "revoke") sessions.revokeById(s.sessionId);
      if (change === "rotate") t.ctx.webToken = "d".repeat(48);
      h.feed({ set: { "preview.optIn": true } });
      await flush();
      outcomes.push([change, h.status(), t.prefs.read().values, t.emitSseEvent.mock.calls.length]);
    }
    expect(outcomes).toEqual([["none", 200, { "preview.optIn": true }, 1], ["revoke", 401, {}, 0], ["rotate", 401, {}, 0]]);
  });
  it("reading /ui/prefs is the page's doing (passive: no session time); writing is the person's", () => {
    expect([isPassiveWebRead("GET", "/ui/prefs"), isPassiveWebRead("POST", "/ui/prefs")]).toEqual([true, false]);
  });
  it("no change: no status frame", async () => {
    const t = setup();
    t.prefs.write(OPERATOR, new Map([["theme", "dark"]]));
    const w = t.write({ set: { theme: "dark" } });
    await flush();
    expect([w.status(), t.emitSseEvent.mock.calls.length]).toEqual([200, 0]);
  });
  it("the public link can read but can never write — any key, the preview opt-in included — and the manifest does not offer the write", async () => {
    const outcomes: unknown[] = [];
    for (const set of [{ theme: "dark" }, { "preview.optIn": true }, { lang: "en" }, { "nav.order": [] }]) {
      const t = setup({ publicLink: true });
      const w = t.write({ set });
      await flush();
      outcomes.push([w.status(), w.json().error, t.prefs.read().values, t.emitSseEvent.mock.calls.length]);
    }
    expect(outcomes).toEqual(Array(4).fill([403, "prefs_not_over_public_link", {}, 0]));
    // It reads what is in force.
    const t = setup({ publicLink: true });
    t.prefs.write(OPERATOR, new Map([["theme", "dark"]]));
    const r = t.read();
    expect([r.status(), r.json()]).toEqual([200, { values: { theme: "dark" }, rev: 1, ownerScope: "none", ownerEpoch: null }]);
    expect([isPublicWebRoute("GET", "/ui/prefs"), isPublicWebRoute("POST", "/ui/prefs")]).toEqual([true, false]);
  });
  it("a read-only session cannot write", async () => {
    const t = setup({ tier: "read" });
    const w = t.write({ set: { theme: "dark" } });
    await flush();
    expect([w.status(), w.json().error, t.prefs.read().values]).toEqual([403, "prefs_read_only", {}]);
  });
  it("an unknown key, __proto__, or one invalid value: 400, and nothing is written", async () => {
    const outcomes: unknown[] = [];
    for (const raw of ['{"set":{"__proto__":"dark"}}', '{"set":{"theme":"dark","bogus":1}}', '{"set":{"theme":"dark","lang":"fr"}}', '{"set":[]}', '{}']) {
      const t = setup();
      const w = t.write(raw);
      await flush();
      outcomes.push([w.status(), t.prefs.read().values, t.prefs.rev()]);
    }
    expect(outcomes).toEqual(Array(5).fill([400, {}, 0]));
  });
  it("onlyIfUnset through the route", async () => {
    const t = setup();
    t.prefs.write(OPERATOR, new Map([["theme", "light"]]));
    const w = t.write({ set: { theme: "dark", lang: "zh-TW" }, onlyIfUnset: true });
    await flush();
    expect(w.json()).toEqual({ values: { theme: "light", lang: "zh-TW" }, rev: 2, changed: ["lang"], ownerScope: "operator", ownerEpoch: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });
  it("a write without the session's CSRF header is refused by the gate", async () => {
    const t = setup();
    const sessions = t.ctx.webSessions as WebSessionStore;
    const s = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
    const h = request("/ui/prefs", "POST", { cookie: `agend_session=${s.sessionId}`, origin: local, "sec-fetch-site": "same-origin" });
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), t.ctx);
    h.feed({ set: { theme: "dark" } });
    await flush();
    expect([h.status(), t.prefs.read().values]).toEqual([401, {}]);
  });
});

describe("#2172: a team's sidebar group is folded and ordered like a tag's — saved, read back, kept across a restart", () => {
  const team = `${TEAM_GROUP_PREFIX}platform-team`;
  const order = [{ item_type: "group", item_name: team, sort_index: 0, group_name: null }, { item_type: "group", item_name: "wiki", sort_index: 1, group_name: null },
    { item_type: "instance", item_name: "search-indexer", sort_index: 0, group_name: team }, { item_type: "instance", item_name: "docs-writer", sort_index: 0, group_name: "wiki" }];
  it("the client's team key is the one the store accepts (instance-nav.js TEAM_GROUP)", () => {
    expect(readFileSync(join(process.cwd(), "src", "ui", "shared", "instance-nav.js"), "utf8")).toContain('export const TEAM_GROUP = "\\u0001team:";');
    expect(TEAM_GROUP_PREFIX).toBe("\u0001team:");
  });
  it("through /ui/prefs: folding a team and an order holding it (a group row and its instance's group_name) — 200, read back the same", async () => {
    const t = setup();
    const w = t.write({ set: { "nav.collapsed": [team, "wiki"], "nav.order": order } });
    await flush();
    expect(w.status()).toBe(200);
    const r = t.read();
    expect(r.json().values).toEqual({ "nav.collapsed": [team, "wiki"], "nav.order": order });
  });
  it("kept across a restart (the file read back by a new store)", () => {
    const dir = tmp(), a = new WebPrefsStore(dir);
    const parsed = parseWebPrefsPatch({ "nav.collapsed": [team], "nav.order": order });
    expect(parsed.ok).toBe(true);
    expect(a.write(OPERATOR, (parsed as { patch: Map<string, unknown> }).patch).ok).toBe(true);
    expect(new WebPrefsStore(dir).read(OPERATOR).values).toEqual({ "nav.collapsed": [team], "nav.order": order });
  });
  it("only that prefix and a valid team name: every other control character, an empty team, and an instance named like a team stay refused", () => {
    for (const key of ["\u0001other:platform-team", "\u0002team:platform-team", TEAM_GROUP_PREFIX, `${TEAM_GROUP_PREFIX}a\u0001b`, `${TEAM_GROUP_PREFIX}${"x".repeat(129)}`, "wiki\u0000", "\u007fwiki"]) {
      expect(parseWebPrefsPatch({ "nav.collapsed": [key] }).ok, JSON.stringify(key)).toBe(false);
      expect(parseWebPrefsPatch({ "nav.order": [{ item_type: "group", item_name: key, sort_index: 0, group_name: null }] }).ok, JSON.stringify(key)).toBe(false);
      expect(parseWebPrefsPatch({ "nav.order": [{ item_type: "instance", item_name: "a", sort_index: 0, group_name: key }] }).ok, JSON.stringify(key)).toBe(false);
    }
    expect(parseWebPrefsPatch({ "nav.order": [{ item_type: "instance", item_name: team, sort_index: 0, group_name: "wiki" }] }).ok, "an instance's own name never takes it").toBe(false);
  });
});

describe("the page carries the host's values (no flash on load)", () => {
  function shell(mode: "full" | "view-only", values: Map<string, unknown>) {
    const prefs = new WebPrefsStore(tmp());
    if (values.size) prefs.write(OPERATOR, values);
    const h = request("/ui");
    serveAppShell(h.req as never, h.res as never, { webPrefs: prefs } as never, mode);
    return h.body();
  }
  it("the signed-in app: <html> has data-prefs (attribute-escaped JSON) and the host's language", () => {
    const page = shell("full", new Map<string, unknown>([["theme", "dark"], ["lang", "zh-TW"], ["nav.filter", { q: `"><script>`, status: [], cli: [] }]]));
    const tag = /<html[^>]*>/.exec(page)![0];
    expect(tag.startsWith('<html lang="zh-Hant" data-prefs="')).toBe(true);
    expect(tag).not.toMatch(/<script|"><|data-prefs="[^"]*"[^>]*"/);
    const raw = /data-prefs="([^"]*)"/.exec(tag)![1]!.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
    expect(JSON.parse(raw)).toEqual({ ownerScope: "none", ownerEpoch: null, rev: 1, values: { theme: "dark", lang: "zh-TW", "nav.filter": { q: `"><script>`, status: [], cli: [] } } });
  });
  it("the anonymous View reader gets the browser's own: no data-prefs", () => {
    expect(/<html[^>]*>/.exec(shell("view-only", new Map([["theme", "dark"]])))![0]).toBe('<html lang="en">');
  });
});

describe("the public link no longer writes the fleet-wide sort order (separate tightening)", () => {
  it("not in the manifest (the listener answers 404), and the handler refuses it too (403); reading stays", () => {
    expect([isPublicWebRoute("POST", "/api/sort-order"), isPublicWebRoute("GET", "/api/sort-order")]).toEqual([false, true]);
    const sessions = new WebSessionStore();
    const s = sessions.create({ tier: "admin", surface: "gateway", exposureId, label: "t", tokenEpoch: tokenEpoch(token) });
    const h = request("/api/sort-order", "POST", { cookie: `__Host-agend_session=${s.sessionId}`, origin: pub, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId) }, "sample.trycloudflare.com");
    bindGatewayRequest(h.req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    const handled = handleViewRequest(h.req as never, h.res as never, new URL(h.req.url, pub),
      { webToken: token, webSessions: sessions, dataDir: tmp(), fleetConfig: { instances: {} }, logger: { info() {}, debug() {}, error() {}, warn() {} } } as never);
    expect([handled, h.status(), h.status() === 403 ? h.json().error : h.body()]).toEqual([true, 403, "sort_order_not_over_public_link"]);
  });
});
