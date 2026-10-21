/** Private FS + actual prefs/library/service/HTTP handlers. No fleet, browser, account or child process. */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATOR, OWNER_EFFECT_KEYS, WebPrefsStore, ownerEffectHolder, parseWebPrefsPatch, webPrefScope } from "../src/web-prefs.js";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { WebEffectProfiles } from "../src/web-effect-profiles.js";
import { WebEffectService } from "../src/web-effect-service.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { encodeEffectFiles } from "../src/web-effect-upload.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { webPersonKey } from "../src/web-profile.js";
import { handleWebRequest, serveAppShell } from "../src/web-api.js";
import { AGENT_WHATS_NEW } from "../src/agent-whats-new.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
const roots: string[] = [], ID = "a".repeat(32), ID2 = "b".repeat(32), token = "c".repeat(48), origin = "http://127.0.0.1:19280";
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tmp() { mkdirSync(".artifacts", { recursive: true }); const p = mkdtempSync(join(process.cwd(), ".artifacts/owner-prefs-")); roots.push(p); return p; }
const patch = (v: Record<string, unknown>) => new Map(Object.entries(v));
const validate = { validateEffect: () => null };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
function files(extra: Record<string, unknown> = {}) {
  const m: Record<string, unknown> = { v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["chat", "sidebar", "header", "page", "box"], layer: "behind", wants: [], box: { anchor: "center", width: 32, height: 32, offset: 0 }, ...extra };
  return new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify(m))], ["worker.js", Buffer.from("agend.ready()")], ...(m.cursor ? [["cursor.png", png] as [string, Uint8Array]] : [])]);
}
function fixture(opts: ConstructorParameters<typeof WebPrefsStore>[1] = {}) {
  const root = tmp(), prefs = new WebPrefsStore(root, opts), library = new WebEffectLibrary(root), profiles = new WebEffectProfiles(root), themes = new ThemeStore(root), sessions = new WebSessionStore();
  library.registerReferenceSource("prefs", () => prefs.ownerEffectReferences());
  library.registerReferenceSource("themes", () => themes.placedEffects().flatMap(p => p.ids.map(id => ({ id, holder: `instance:${p.name}` }))));
  const emit = vi.fn(), service = new WebEffectService({ library, prefs, profiles, themes, known: n => n === "worker", changed: emit });
  const ctx = { fleetConfig: { web: { experimental: { canvas_worker: true } } }, webToken: token, webSessions: sessions, webPrefs: prefs, effectService: service, logger: { info() {}, debug() {}, warn() {}, error() {} }, getUiStatus: () => ({}), emitSseEvent: emit } as any;
  const session = (user: string | null = "alice", adapterId = "discord", tier: "read" | "admin" = "admin") => {
    const owner = user === null ? undefined : { adapterId, userId: user }, made = sessions.create({ tier, surface: "local", label: "test", tokenEpoch: tokenEpoch(token), ...(owner ? { owner } : {}) });
    return { ...made, person: webPersonKey(owner), headers: { cookie: `agend_session=${made.sessionId}`, origin, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(made.sessionId) } };
  };
  const begin = (method: string, path: string, headers: Record<string, string> = {}) => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "127.0.0.1:19280", ...headers }, destroy: vi.fn(), resume() {}, socket: { destroy: vi.fn() } });
    let status = 0, body: string | Buffer = "";
    const res: any = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, setHeader() {}, writeHead(n: number) { status = n; this.headersSent = true; }, end(x: any = "") { body = x; }, write() { return true; } });
    return { req, res, start: () => handleWebRequest(req as never, res, new URL(path, origin), ctx), feed: (v: unknown) => { req.emit("data", Buffer.from(JSON.stringify(v))); req.emit("end"); }, status: () => status, json: () => JSON.parse(String(body)), body: () => body };
  };
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => { const r = begin(method, path, headers); r.start(); if (body !== undefined) r.feed(body); await settle(); return { status: r.status(), body: r.body(), json: typeof r.body() === "string" && String(r.body()).startsWith("{") ? r.json() : null }; };
  const upload = (person: string, extra: Record<string, unknown> = {}) => { const r = service.upload(person, encodeEffectFiles(files(extra))!); expect(r.id, JSON.stringify(r)).toEqual(expect.any(String)); return r.id as string; };
  const select = (person: string, selections: Record<string, unknown>) => prefs.writeForViewer(person, patch(selections), { validateEffect: (p, k, id) => service.validateOwnerSelection(p, k, id) });
  return { root, prefs, library, profiles, themes, sessions, service, ctx, session, begin, call, upload, select, emit };
}

describe("fixed preference scope and one atomic mixed transaction", () => {
  // #2012: the agent guidance moved from the what's-new entry into the web-appearance skill (what's-new names the skill).
  const SKILL = readFileSync(join(process.cwd(), "src/general-knowledge/skills/web-appearance/SKILL.md"), "utf8").replace(/\s+/g, " ");
  it("agent guidance keeps host-wide operator, withdrawal and chat retention distinct", () => {
    expect(AGENT_WHATS_NEW.some(e => e.id === "2.3-owner-effect-policy"), "folded into the web-appearance skill").toBe(false);
    for (const words of ["never agent tool targets", "**host-wide operator** bucket", "becomes unavailable at its next resource authorization", "keeps the blob from being collected until cleared", "deliberately stricter than chat placements' retained-runtime reads", "play across supported stock pages in the same pool as signed-in Chat", "The personal cursor uses a static PNG on the host shell without HTML-preview consent: no Worker/code read or frame slot", "Only an explicit click by a signed-in **admin outside the public link** may start it"]) expect(SKILL, words).toContain(words);
  });
  it("the guidance no longer describes Try as unavailable", () => {
    expect(SKILL).not.toContain("Try remains separate work");
  });
  it("only five keys are personal; old host/internal keys retain their scope", () => {
    expect(OWNER_EFFECT_KEYS.map(webPrefScope)).toEqual(Array(5).fill("person"));
    expect(["theme", "fx.show", "preview.optIn", "widget.sidebar"].map(webPrefScope)).toEqual(Array(4).fill("host"));
    expect([webPrefScope("profile.name"), webPrefScope("css.active"), webPrefScope("constructor")]).toEqual(["internal", "internal", null]);
    for (const key of OWNER_EFFECT_KEYS) { expect(parseWebPrefsPatch({ [key]: ID }).ok).toBe(true); expect(parseWebPrefsPatch({ [key]: null }).ok).toBe(true); }
  });
  it("publishes host and person buckets in one write/revision; neither shadows the other", () => {
    let writes = 0; const f = fixture({ write: (path, text) => { writes++; writeFileSync(path, text); } });
    const r = f.prefs.writeForViewer("person:discord:alice", patch({ theme: "dark", "fx.page": ID }), validate);
    expect(r).toMatchObject({ ok: true, changed: ["theme", "fx.page"], view: { rev: 1, values: { theme: "dark", "fx.page": ID } } }); expect(writes).toBe(1);
    const doc = JSON.parse(readFileSync(f.prefs.path, "utf8"));
    expect(doc.identities.operator.values).toEqual({ theme: "dark" }); expect(doc.identities["person:discord:alice"].values).toEqual({ "fx.page": ID });
    f.prefs.write("person:discord:alice", patch({ theme: "light" }));
    expect(f.prefs.readForViewer("person:discord:alice").values).toEqual({ theme: "dark", "fx.page": ID });
    expect(new WebPrefsStore(f.root).readForViewer("person:discord:alice")).toEqual(f.prefs.readForViewer("person:discord:alice"));
  });
  it("a failed mixed write publishes neither memory nor disk; validation refuses the whole patch", () => {
    let fail = false; const f = fixture({ write: (path, text) => { if (fail) throw Error("disk full"); writeFileSync(path, text); } });
    f.prefs.writeForViewer("alice", patch({ theme: "dark", "fx.page": ID }), validate); const before = readFileSync(f.prefs.path, "utf8"); fail = true;
    expect(() => f.prefs.writeForViewer("bob", patch({ theme: "light", "fx.page": ID2 }), validate)).toThrow("disk full");
    expect(readFileSync(f.prefs.path, "utf8")).toBe(before); expect(f.prefs.readForViewer("bob")).toEqual({ values: { theme: "dark" }, rev: 1 });
    expect(f.prefs.writeForViewer("bob", patch({ theme: "light", "fx.page": ID }), { validateEffect: () => "not_found" })).toMatchObject({ ok: false, error: "not_found" }); expect(f.prefs.rev()).toBe(1);
    expect(f.prefs.writeForViewer(null, patch({ theme: "light", "fx.page": null }), validate)).toMatchObject({ ok: false }); expect(f.prefs.rev()).toBe(1);
  });
  it("preserves special raw bucket names across a later mixed publication", () => {
    const f = fixture(); f.prefs.write("__proto__", patch({ "fx.page": ID })); f.prefs.writeForViewer("alice", patch({ theme: "dark", "fx.page": ID2 }), validate);
    const reopened = new WebPrefsStore(f.root); expect(reopened.ownerEffectReferences()).toContainEqual({ id: ID, holder: ownerEffectHolder("__proto__", "fx.page") });
    expect(Object.hasOwn(JSON.parse(readFileSync(f.prefs.path, "utf8")).identities, "__proto__")).toBe(true);
  });
  it("the explicit operator merges into one bucket but host-only reads hide its personal keys", () => {
    const f = fixture(); f.prefs.writeForViewer(OPERATOR, patch({ theme: "dark", "fx.page": ID }), validate);
    expect(f.prefs.readForViewer(OPERATOR)).toEqual({ values: { theme: "dark", "fx.page": ID }, rev: 1 });
    expect(f.prefs.readForViewer(null)).toEqual({ values: { theme: "dark" }, rev: 1 }); expect(f.prefs.readForViewer("alice")).toEqual({ values: { theme: "dark" }, rev: 1 });
    expect(f.prefs.writeForViewer(OPERATOR, patch({ "fx.page": ID2, lang: "en" }), { ...validate, onlyIfUnset: true })).toMatchObject({ ok: true, changed: ["lang"] });
    expect(f.prefs.readForViewer(OPERATOR).values["fx.page"]).toBe(ID);
  });
  it("keeps adapter/user buckets separate and creates no migration of existing host values", () => {
    const f = fixture(); f.prefs.write(OPERATOR, patch({ "fx.show": false, "preview.optIn": true })); const d = webPersonKey({ adapterId: "discord", userId: "7" }), t = webPersonKey({ adapterId: "telegram", userId: "7" });
    f.prefs.writeForViewer(d, patch({ "fx.page": ID }), validate); f.prefs.writeForViewer(t, patch({ "fx.page": ID2 }), validate);
    expect([f.prefs.readForViewer(d).values["fx.page"], f.prefs.readForViewer(t).values["fx.page"], f.prefs.readForViewer(OPERATOR).values["fx.page"]]).toEqual([ID, ID2, undefined]);
    const disk = JSON.parse(readFileSync(f.prefs.path, "utf8")); expect(disk.identities.operator.values).toEqual({ "fx.show": false, "preview.optIn": true });
  });
  it("references enumerate every bucket with bounded holders; malformed/unreadable references refuse", () => {
    const f = fixture(), long = "person:" + "x".repeat(128) + ":" + "y".repeat(128);
    f.prefs.writeForViewer(OPERATOR, patch({ "fx.page": ID }), validate); f.prefs.writeForViewer(long, patch({ "fx.cursor": ID2 }), validate);
    expect(f.prefs.ownerEffectReferences()).toEqual([{ id: ID, holder: ownerEffectHolder(OPERATOR, "fx.page") }, { id: ID2, holder: ownerEffectHolder(long, "fx.cursor") }]);
    expect(ownerEffectHolder(long, "fx.cursor").length).toBeLessThan(256);
    const disk = JSON.parse(readFileSync(f.prefs.path, "utf8")); disk.identities[long].values["fx.cursor"] = "damaged"; writeFileSync(f.prefs.path, JSON.stringify(disk));
    const fresh = new WebPrefsStore(f.root); expect(fresh.readForViewer(OPERATOR)).toMatchObject({ unreadable: true }); expect(() => fresh.ownerEffectReferences()).toThrow("prefs_unreadable");
    expect(fresh.writeForViewer(OPERATOR, patch({ "fx.page": null }))).toMatchObject({ ok: false, status: 503 });
  });
});

describe("session-scoped preferences and runtime resources", () => {
  it("uses bound identities or the explicit web-only operator, with a session marker", async () => {
    const f = fixture(), a = f.session(), op = f.session(null), id = f.upload(a.person), oid = f.upload(OPERATOR, { title: "Operator" });
    for (const [s, effect, scope] of [[a, id, "person"], [op, oid, "operator"]] as const) {
      const read = await f.call("GET", "/ui/prefs", s.headers); expect(read.json).toMatchObject({ ownerScope: scope, ownerEpoch: s.record.handle });
      const saved = await f.call("POST", "/ui/prefs", s.headers, { set: { "fx.page": effect }, ownerEpoch: read.json.ownerEpoch }); expect(saved.status).toBe(200); expect(saved.json.values["fx.page"]).toBe(effect);
    }
    expect((await f.call("GET", "/ui/prefs", a.headers)).json.values["fx.page"]).toBe(id);
    expect((await f.call("GET", "/ui/prefs", op.headers)).json.values["fx.page"]).toBe(oid);
  });
  it("header tokens, even with a cookie, neither read nor clear personal operator keys; mixed writes are atomic", async () => {
    const f = fixture(), op = f.session(null), id = f.upload(OPERATOR); f.select(OPERATOR, { "fx.page": id });
    const headers = { ...op.headers, "x-agend-token": token };
    const read = await f.call("GET", "/ui/prefs", headers); expect(read.json).toMatchObject({ ownerScope: "none", ownerEpoch: null }); expect(read.json.values).toEqual({});
    const r = await f.call("POST", "/ui/prefs", headers, { set: { theme: "dark", "fx.page": null }, ownerEpoch: op.record.handle }); expect(r.status).toBe(403); expect(f.prefs.read().values.theme).toBeUndefined(); expect(f.prefs.read().values["fx.page"]).toBe(id);
    expect((await f.call("POST", "/ui/prefs", headers, { set: { theme: "dark" } })).status).toBe(200);
    expect((await f.call("GET", "/ui/effects/owner", headers)).status).toBe(403);
  });
  it("rejects a missing/old session marker even after the same person signs in again", async () => {
    const f = fixture(), a = f.session(), b = f.session(), id = f.upload(a.person);
    for (const epoch of [undefined, "0".repeat(16), a.record.handle]) expect((await f.call("POST", "/ui/prefs", b.headers, { set: { theme: "dark", "fx.page": id }, ownerEpoch: epoch })).status).toBe(409);
    expect(f.prefs.rev()).toBe(0); expect((await f.call("POST", "/ui/prefs", b.headers, { set: { "fx.page": id }, ownerEpoch: b.record.handle })).status).toBe(200);
  });
  it("revalidates the person/session after a held body and retains the real server ACL", async () => {
    const f = fixture(), a = f.session(), b = f.session("bob"), id = f.upload(a.person), r = f.begin("POST", "/ui/prefs", a.headers); r.start();
    Object.assign(r.req.headers, b.headers); r.feed({ set: { "fx.page": id }, ownerEpoch: b.record.handle }); await settle();
    expect(r.status()).toBe(409); expect(f.prefs.rev()).toBe(0);
    expect((await f.call("POST", "/ui/prefs", b.headers, { set: { "fx.page": id }, ownerEpoch: b.record.handle, person: a.person })).status).toBe(400); expect(f.prefs.rev()).toBe(0);
    const readOnly = f.session("alice", "discord", "read"); expect((await f.call("POST", "/ui/prefs", readOnly.headers, { set: { "fx.page": id }, ownerEpoch: readOnly.record.handle })).status).toBe(403);
    const noCsrf = { ...a.headers }; delete (noCsrf as any)["x-agend-csrf"]; expect((await f.call("POST", "/ui/prefs", noCsrf, { set: { "fx.page": id }, ownerEpoch: a.record.handle })).status).toBe(401);
  });
  it.each(["other-person", "same-person-new-session"])("a held write cannot retarget a readable effect after %s", async mode => {
    const f = fixture(), a = f.session(), b = f.session(mode === "other-person" ? "bob" : "alice"), id = f.upload(a.person); f.service.share(a.person, { id, shared: true });
    const r = f.begin("POST", "/ui/prefs", a.headers); r.start(); Object.assign(r.req.headers, b.headers);
    r.feed({ set: { "fx.page": id }, ownerEpoch: b.record.handle }); await settle(); expect(r.status()).toBe(409); expect(f.prefs.rev()).toBe(0);
  });
  it("validates region/box/cursor declarations before writing; unavailable values can always be cleared", async () => {
    const f = fixture(), a = f.session(), chat = f.upload(a.person, { regions: ["chat"] }), noBox = f.upload(a.person, { regions: ["box"], box: undefined }), cursor = f.upload(a.person, { cursor: { hotspot: [0, 0] } });
    for (const [key, id] of [["fx.page", chat], ["fx.box", noBox], ["fx.cursor", chat]]) expect(f.select(a.person, { [key]: id })).toMatchObject({ ok: false });
    expect(f.select(a.person, { "fx.cursor": cursor })).toMatchObject({ ok: true }); expect(f.service.ownerResource(a.person, cursor, "fx.cursor")).toEqual({ error: "not_found" }); expect(f.service.ownerImage(a.person, cursor, "cursor", "fx.cursor")).toMatchObject({ ok: true });
    expect(f.prefs.writeForViewer(a.person, patch({ "fx.cursor": null }))).toMatchObject({ ok: true });
  });
  it("withdraws personal runtime authorization after unshare, keeps its reference and preserves chat retention", async () => {
    const f = fixture(), a = f.session(), b = f.session("bob"), id = f.upload(b.person); f.service.share(b.person, { id, shared: true }); f.select(a.person, { "fx.page": id }); f.service.apply(b.person, { instance: "worker", id });
    const resource = `/ui/effects/resource/${id}?slot=fx.page&ownerEpoch=${a.record.handle}`;
    expect((await f.call("GET", resource, a.headers)).json).toMatchObject({ code: "agend.ready()" });
    f.service.share(b.person, { id, shared: false });
    expect((await f.call("GET", resource, a.headers)).status).toBe(404);
    expect((await f.call("GET", `/ui/effects/resource/${id}?ownerEpoch=${a.record.handle}`, a.headers)).status).toBe(404);
    expect((await f.call("GET", `/ui/effects/resource/${id}?instance=worker&ownerEpoch=${a.record.handle}`, a.headers)).status).toBe(200);
    expect((await f.call("GET", `/ui/effects/owner?ownerEpoch=${a.record.handle}`, a.headers)).json.slots["fx.page"]).toEqual({ id, status: "unavailable" });
    expect(f.prefs.ownerEffectReferences()).toContainEqual({ id, holder: ownerEffectHolder(a.person, "fx.page") });
    expect(f.service.delete(b.person, id)).toEqual({ error: "effect_in_use" });
    expect((await f.call("POST", "/ui/prefs", a.headers, { set: { "fx.page": null }, ownerEpoch: a.record.handle })).status).toBe(200); expect(f.prefs.ownerEffectReferences()).toEqual([]);
  });
  it("requires the exact slot and never borrows a different person's retained preference", async () => {
    const f = fixture(), a = f.session(), b = f.session("bob"), id = f.upload(a.person); f.service.share(a.person, { id, shared: true }); f.select(a.person, { "fx.page": id });
    for (const url of [`/ui/effects/resource/${id}?slot=fx.header&ownerEpoch=${a.record.handle}`, `/ui/effects/resource/${id}?slot=constructor&ownerEpoch=${a.record.handle}`, `/ui/effects/resource/${id}?slot=fx.page&instance=worker&ownerEpoch=${a.record.handle}`]) expect((await f.call("GET", url, a.headers)).status).toBe(404);
    expect((await f.call("GET", `/ui/effects/resource/${id}?slot=fx.page&ownerEpoch=${b.record.handle}`, b.headers)).status).toBe(404);
    expect(f.service.ownerSelections(b.person)).toMatchObject({ slots: { "fx.page": { id: null, status: "none" } } });
  });
  it("a withdrawn shared cursor becomes unavailable and its host image is no longer authorized", async () => {
    const f = fixture(), a = f.session(), b = f.session("bob"), id = f.upload(b.person, { cursor: { hotspot: [0, 0] } }); f.service.share(b.person, { id, shared: true }); f.select(a.person, { "fx.cursor": id });
    const url = `/ui/effects/image/${id}/cursor.png?slot=fx.cursor&ownerEpoch=${a.record.handle}`;
    expect((await f.call("GET", url, a.headers)).status).toBe(200); f.service.share(b.person, { id, shared: false });
    expect((await f.call("GET", url, a.headers)).status).toBe(404);
    expect(f.service.ownerSelections(a.person)).toMatchObject({ slots: { "fx.cursor": { id, status: "unavailable" } } }); expect(f.prefs.ownerEffectReferences()).toHaveLength(1);
  });
  it("a successful clear triggers collection only after the new durable index is visible", async () => {
    const f = fixture(), a = f.session(), id = f.upload(a.person); f.select(a.person, { "fx.page": id });
    const seen: unknown[] = []; vi.spyOn(f.service, "collectOwnerReplaced").mockImplementation(ids => { seen.push({ ids, stored: new WebPrefsStore(f.root).readForViewer(a.person).values["fx.page"] }); });
    const r = await f.call("POST", "/ui/prefs", a.headers, { set: { "fx.page": null }, ownerEpoch: a.record.handle });
    expect(r.status).toBe(200); expect(seen).toEqual([{ ids: [id], stored: undefined }]);
  });
  it("requires the current session's scope marker on owner state/resource/image reads before returning bytes", async () => {
    const f = fixture(), a = f.session(), b = f.session(), id = f.upload(a.person, { cursor: { hotspot: [0, 0] } }); f.select(a.person, { "fx.page": id, "fx.cursor": id });
    for (const path of [`/ui/effects/resource/${id}?slot=fx.page`, `/ui/effects/image/${id}/cursor.png?slot=fx.cursor`]) {
      expect((await f.call("GET", path, a.headers)).status).toBe(404);
      expect((await f.call("GET", path + `&ownerEpoch=${b.record.handle}`, a.headers)).status).toBe(404);
      expect((await f.call("GET", path + `&ownerEpoch=${a.record.handle}`, a.headers)).status).toBe(200);
    }
    expect((await f.call("GET", "/ui/effects/owner", a.headers)).status).toBe(409);
    expect((await f.call("GET", `/ui/effects/owner?ownerEpoch=${a.record.handle}`, b.headers)).status).toBe(409);
    expect((await f.call("GET", `/ui/effects/owner?ownerEpoch=${a.record.handle}`, a.headers)).status).toBe(200);
  });
  it("an unreadable bucket yields unknown, denies runtime code and prevents collection", async () => {
    const f = fixture(), a = f.session(), id = f.upload(a.person); f.select(a.person, { "fx.page": id }); writeFileSync(f.prefs.path, "{");
    const broken = new WebPrefsStore(f.root), service = new WebEffectService({ library: f.library, prefs: broken, themes: f.themes, profiles: f.profiles, known: () => true, changed() {} }); f.ctx.webPrefs = broken; f.ctx.effectService = service;
    expect((await f.call("GET", "/ui/prefs", a.headers)).json).toMatchObject({ unreadable: true });
    expect((await f.call("GET", `/ui/effects/owner?ownerEpoch=${a.record.handle}`, a.headers)).status).toBe(503); expect((await f.call("GET", `/ui/effects/resource/${id}?slot=fx.page&ownerEpoch=${a.record.handle}`, a.headers)).status).toBe(404);
    f.library.registerReferenceSource("broken-prefs", () => broken.ownerEffectReferences()); expect(f.library.deleteClaim(id, { kind: "human", id: a.person })).toMatchObject({ ok: false, error: "references_unreadable" });
    expect(readFileSync(f.prefs.path, "utf8")).toBe("{");
  });
  it("boot uses the current session's scope, keeps unreadability and never includes personal fields in header/public/View loads", () => {
    const f = fixture(), a = f.session(), op = f.session(null), id = f.upload(a.person), oid = f.upload(OPERATOR, { title: "Operator" }); f.select(a.person, { "fx.page": id }); f.select(OPERATOR, { "fx.page": oid });
    const boot = (headers: Record<string, string>, mode: "full" | "view-only" = "full", gateway = false) => {
      const r = f.begin("GET", "/ui", headers); if (gateway) bindGatewayRequest(r.req as never, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: origin, isCurrent: () => true });
      serveAppShell(r.req as never, r.res, f.ctx, mode); const raw = /data-prefs="([^"]*)"/.exec(String(r.body()))?.[1]; return raw ? JSON.parse(raw.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))) : null;
    };
    expect(boot(a.headers)).toMatchObject({ ownerScope: "person", ownerEpoch: a.record.handle, values: { "fx.page": id } });
    expect(boot(op.headers)).toMatchObject({ ownerScope: "operator", values: { "fx.page": oid } });
    expect(boot({ ...op.headers, "x-agend-token": token })).toMatchObject({ ownerScope: "none" }); expect(boot({ ...op.headers, "x-agend-token": token }).values).toEqual({});
    expect(boot(a.headers, "view-only")).toBeNull(); expect(boot(a.headers, "full", true)).toMatchObject({ ownerScope: "none" }); expect(boot(a.headers, "full", true).values).toEqual({});
    writeFileSync(f.prefs.path, "{"); f.ctx.webPrefs = new WebPrefsStore(f.root); expect(boot(a.headers)).toMatchObject({ unreadable: true, values: {} });
  });
});
