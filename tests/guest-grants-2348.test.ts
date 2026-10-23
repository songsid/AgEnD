/**
 * #2348: an admin grants each person the agents they may see as a guest, and can send them a sign-in code.
 * - The patch and the validator: `grants: { "<connection>:<user>": { name?, instances } | null }`; removing the last
 *   grant keeps `grants: {}` (its presence is default deny).
 * - The gate: adding a person, or an agent to one, waits for a fleet admin; removing, narrowing or renaming applies at once.
 * - Through the real gate and handler: a new grant only for someone seen in chat and not a fleet admin (refused at apply
 *   otherwise); a grant taken away ends that person's access at once; the people list and Send sign-in code are an
 *   admin's, never over the public link.
 * - seen_people: written from human receipts (platform senders only), backfilled once, listed newest first.
 * - sendGuestCodeByAdmin on a real FleetManager with a stubbed adapter (no real DM is ever sent): DM only, once a minute
 *   per person, a per-admin cap, refused without guests, for an admin or with nothing granted; a failed DM says why.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
  rotateLogIfNeeded: () => { throw new Error("log rotation is outside this harness"); },
  rotateLogIfNeededAsync: async () => { throw new Error("log rotation is outside this harness"); },
}));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("process execution is outside this harness"); };
  return { ...original, spawn: blocked, spawnSync: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked };
});
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { EventLog } from "../src/event-log.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { applyGuestsPatch, guestsPatch } from "../src/web-settings-patch.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { initializeSeenPeople, listSeenPeople, noteSeenPerson, pruneSeenPeople } from "../src/guest-seen-people.js";

const roots: string[] = [], stores: SettingsConfirmationStore[] = [], outboxes: Array<{ close(): void }> = [];
afterEach(() => {
  for (const o of outboxes.splice(0)) { try { o.close(); } catch { /* closed */ } }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  vi.restoreAllMocks();
});
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };

const WEB = "/api/settings/fleet/web";
const FLEET = { channels: [{ id: "dc", type: "discord", group_id: "G", bot_token_env: "X" }], instances: { a: { working_directory: "/tmp" }, b: { working_directory: "/tmp" } } };
const judge = (guests: unknown, web: Record<string, unknown> = {}) =>
  prepareSettingsEffect("PUT", WEB, { guests }, { config: { defaults: {}, ...structuredClone(FLEET), web } as any, classic: {} }).diff;
const named = (d: { summary: readonly string[] } | null) => (d ? d.summary.join(" | ") : null);

describe("the patch and the validator", () => {
  it("parses a grant, null (removed); refuses a bad key, an unknown field, a non-list, a long name", () => {
    expect(guestsPatch({ grants: { "dc:111": { name: "Ada", instances: ["a"] }, "dc:222": null } }))
      .toEqual({ grants: { "dc:111": { name: "Ada", instances: ["a"] }, "dc:222": null } });
    for (const bad of [{ grants: ["x"] }, { grants: { dc: { instances: ["a"] } } }, { grants: { "dc:1 2": { instances: ["a"] } } },
      { grants: { "dc:111": { instances: "a" } } }, { grants: { "dc:111": { instances: ["a"], extra: 1 } } }, { grants: { "dc:111": { name: "x".repeat(101), instances: ["a"] } } },
      { grants: { "dc:111": {} } }, { grants: { "dc:111": { instances: ["a", "a"] } } }]) {
      expect(guestsPatch(bad), JSON.stringify(bad).slice(0, 70)).toBe("invalid");
    }
  });
  it("applies: a grant replaced whole; removing the last one keeps grants: {} — default deny stays", () => {
    const one = applyGuestsPatch({ enabled: true }, { grants: { "dc:111": { instances: ["a"] } } });
    expect(one.next).toEqual({ enabled: true, grants: { "dc:111": { instances: ["a"] } } });
    const replaced = applyGuestsPatch(one.next, { grants: { "dc:111": { name: "Ada", instances: ["b"] } } });
    expect(replaced.next?.grants).toEqual({ "dc:111": { name: "Ada", instances: ["b"] } });
    const gone = applyGuestsPatch(replaced.next, { grants: { "dc:111": null } });
    expect(gone.next).toEqual({ enabled: true, grants: {} });
    expect(gone.changes.at(-1)).toEqual({ path: ["web", "guests", "grants"], value: {} });
  });
  it("the validator: grants' shape is an error, a name not in the fleet a warning", () => {
    const base = { defaults: {}, ...structuredClone(FLEET) } as any;
    const v = (grants: unknown) => validateFleetConfig({ ...base, web: { guests: { enabled: true, grants } } });
    expect(v({ "dc:111": { instances: ["a"] } }).errors).toEqual([]);
    expect(v({ "dc:111": { instances: ["nope"] } }).warnings.map((w: any) => w.message ?? String(w)).join("\n")).toMatch(/"nope" is not an instance/);
    for (const bad of [["x"], { dc: { instances: ["a"] } }, { "dc:111": { instances: "a" } }, { "dc:111": { instances: ["a"], extra: 1 } }]) {
      expect(v(bad).errors.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });
});

describe("the gate: what waits for a fleet admin", () => {
  const G = (grants: unknown) => ({ guests: { enabled: true, grants } });
  it("adding a person, or an agent to someone's grant, waits; the person and the agents are named", () => {
    expect(named(judge({ grants: { "dc:111": { instances: ["a"] } } }, G({})))).toMatch(/grants\.dc:111/);
    expect(named(judge({ grants: { "dc:111": { instances: ["a", "b"] } } }, G({ "dc:111": { instances: ["a"] } })))).toMatch(/grants\.dc:111/);
    // Turning grants on with someone in them: that person may now see more than nothing.
    expect(named(judge({ grants: { "dc:111": { instances: ["a"] } } }, { guests: { enabled: true } }))).toMatch(/grants\.dc:111/);
  });
  it("taking `grants` away altogether (a raw edit) brings the derived scope back: it waits", () => {
    const diff = settingsChangeDiff({ fleet: { web: { guests: { enabled: true, grants: { "dc:111": { instances: ["a"] } } } } } },
      { fleet: { web: { guests: { enabled: true } } } }, { operation: "PUT x" });
    expect(diff?.summary.join(" | ")).toMatch(/grants/);
  });
  it("removing, narrowing, renaming, or turning grants on empty applies at once", () => {
    const before = G({ "dc:111": { name: "Ada", instances: ["a", "b"] } });
    expect(judge({ grants: { "dc:111": null } }, before)).toBeNull();
    expect(judge({ grants: { "dc:111": { name: "Ada", instances: ["a"] } } }, before)).toBeNull();
    expect(judge({ grants: { "dc:111": { name: "Ada L.", instances: ["a", "b"] } } }, before)).toBeNull();
    expect(judge({ grants: {} }, { guests: { enabled: true } })).toBeNull();
  });
});

function harness(fleet: Record<string, unknown> = {}, opts: { refuse?: (a: string, u: string) => string | null } = {}) {
  const root = tmp("agend-2348g-");
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, ...structuredClone(FLEET), ...structuredClone(fleet) };
  writeFileSync(path, yaml.dump(config));
  let revision = 0;
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); revision++; });
  const revoke = vi.fn((_owner: { adapterId: string; userId: string }) => ({ count: 1, durable: true }));
  const people = vi.fn(() => ({ people: [{ adapterId: "dc", userId: "111", username: "ada" }] }));
  const sendCode = vi.fn(async (_o: unknown, _by: string, _current?: () => boolean) => ({ status: 200, body: { ok: true, outcome: "sent" } }));
  const note = vi.fn((_c: { by: string | null; via: string; account: string; added: string[]; removed: string[]; endedSessions: number }) => undefined);
  const refusal = vi.fn(opts.refuse ?? ((_a: string, u: string) => (u === "111" ? null : "only someone AgEnD has seen in chat can be given guest access")));
  const TOKEN = "c".repeat(48), sessions = new WebSessionStore();
  const sid = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(TOKEN) }).sessionId as string;
  const guestSid = sessions.create({ tier: "guest", surface: "local", label: "guest", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "dc", userId: "999" } }).sessionId as string;
  const ctx = { fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, webToken: TOKEN, webSessions: sessions,
    getRawFleetConfig: () => config, saveFleetConfig: save, lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
    guestOverview: () => ({ audit: [{ kind: "grant", at: 1, account: "dc:111", name: "Ada", via: "direct", added: [], removed: ["a"], endedSessions: 1 }] }), revokeGuestWebSessions: revoke, guestPeople: people, guestGrantRefusal: refusal, sendGuestCodeByAdmin: sendCode, noteGuestGrantChange: note } as unknown as SettingsApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => revision });
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => req.headers.cookie ? { id: "session-a", label: "browser", source: "web_session", current: () => true } : null,
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  function request(method: string, url: string, body?: unknown, o: { publicLink?: boolean; as?: "admin" | "guest" | "none" } = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new EventEmitter() as any;
      req.method = method; req.url = url; req.destroy = () => undefined;
      const who = o.as === "guest" ? guestSid : o.as === "none" ? "not-a-session" : sid;
      req.headers = { "idempotency-key": `k-${Math.random()}`, host: "localhost", origin: "http://localhost", cookie: `${WEB_SESSION_COOKIE}=${who}`, [WEB_CSRF_HEADER]: csrfTokenFor(who) };
      if (o.publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.example", isCurrent: () => true });
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, ctx);
      try { const u = new URL(url, "http://localhost"); if (!gate.handle(req, res, u, next)) expect(next(req, res, u)).toBe(true);
        queueMicrotask(() => { if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); }
      catch (err) { reject(err); }
    });
  }
  const raw = () => yaml.load(readFileSync(path, "utf8")) as any;
  return { config, save, store, request, raw, revoke, people, sendCode, refusal, sessions, note, sid };
}
const confirmer = () => ({ label: "F", current: () => true });

describe("through the real gate and handler", () => {
  it("a new grant waits for a fleet admin, then is written; narrowing it applies at once", async () => {
    const h = harness({ web: { guests: { enabled: true } } });
    const add = await h.request("PUT", WEB, { guests: { grants: { "dc:111": { name: "Ada", instances: ["a", "b"] } } } });
    expect([add.status, add.body.result]).toEqual([202, "pending_confirmation"]);
    expect(h.raw().web.guests.grants).toBeUndefined();
    expect((await h.store.decide(add.body.pending_change.id, "confirm", confirmer())).state).toBe("applied");
    expect(h.raw().web.guests.grants).toEqual({ "dc:111": { name: "Ada", instances: ["a", "b"] } });
    const narrow = await h.request("PUT", WEB, { guests: { grants: { "dc:111": { name: "Ada", instances: ["a"] } } } });
    expect(narrow.status).toBe(200);
    expect(h.raw().web.guests.grants["dc:111"].instances).toEqual(["a"]);
    expect(h.revoke, "narrowed: sessions stay (they see less)").not.toHaveBeenCalled();
  });
  it("#2365 review: turning grants on with no one in them is kept — grants: {} on disk, at once (it only takes away)", async () => {
    expect(guestsPatch({ grants: {} })).toEqual({ grants: {} });
    const h = harness({ web: { guests: { enabled: true } } });
    const on = await h.request("PUT", WEB, { guests: { grants: {} } });
    expect(on.status).toBe(200);
    expect(h.raw().web.guests).toEqual({ enabled: true, grants: {} });
    expect(h.config.web.guests.grants).toEqual({});
  });
  it("taken away (or emptied): applied at once, and that person's access ends now; grants: {} stays", async () => {
    const h = harness({ web: { guests: { enabled: true, grants: { "dc:111": { instances: ["a"] }, "dc:222": { instances: ["b"] } } } } });
    expect((await h.request("PUT", WEB, { guests: { grants: { "dc:111": null, "dc:222": { instances: [] } } } })).status).toBe(200);
    expect(h.raw().web.guests.grants).toEqual({ "dc:222": { instances: [] } });
    expect(h.revoke.mock.calls.map((c) => c[0])).toEqual([{ adapterId: "dc", userId: "111" }, { adapterId: "dc", userId: "222" }]);
    expect((await h.request("PUT", WEB, { guests: { grants: { "dc:222": null } } })).status).toBe(200);
    expect(h.raw().web.guests).toEqual({ enabled: true, grants: {} });
  });
  // #2348 design delta §5: removing or narrowing a grant applies at once and used to leave no record anywhere.
  it("every grant change is audited: a confirmed widening, a narrowing and a removal at once (with the sessions ended); a save that changes no grant is not", async () => {
    const h = harness({ web: { guests: { enabled: true, grants: { "dc:222": { instances: ["b"] } } } } });
    const add = await h.request("PUT", WEB, { guests: { grants: { "dc:111": { name: "Ada", instances: ["a", "b"] } } } });
    expect(h.note, "nothing applied yet: nothing audited").not.toHaveBeenCalled();
    expect((await h.store.decide(add.body.pending_change.id, "confirm", confirmer())).state).toBe("applied");
    expect(h.note.mock.calls.map((c) => c[0])).toEqual([{ by: null, via: "confirmed", account: "dc:111", added: ["a", "b"], removed: [], endedSessions: 0 }]);
    h.note.mockClear();
    expect((await h.request("PUT", WEB, { guests: { grants: { "dc:111": { name: "Ada", instances: ["a"] }, "dc:222": null } } })).status).toBe(200);
    const by = `session:${h.sessions.list(undefined, (r: any) => r.tier === "admin")[0].handle}`;
    expect(h.note.mock.calls.map((c) => c[0])).toEqual([
      { by, via: "direct", account: "dc:222", added: [], removed: ["b"], endedSessions: 1 },
      { by, via: "direct", account: "dc:111", added: [], removed: ["b"], endedSessions: 0 },
    ]);
    h.note.mockClear();
    expect((await h.request("PUT", WEB, { guests: { grants: { "dc:111": { name: "Ada L.", instances: ["a"] } } } })).status).toBe(200);
    expect((await h.request("PUT", WEB, { guests: { chat: false } })).status).toBe(200);
    expect(h.note, "a rename and a save without grants change no one's agents").not.toHaveBeenCalled();
  });
  // #2499 review (Prism P2): a session policy saved together with the grant change can end the saving admin's own session;
  // the audit still names who saved it (asked before the save), and a confirmation's replay stays null.
  it("the saver is the one asked before the save, even when the save ends that admin's own session", async () => {
    const h = harness({ web: { guests: { enabled: true, grants: { "dc:111": { instances: ["a", "b"] } } } } });
    const handle = h.sessions.list(undefined, (r: any) => r.tier === "admin")[0].handle;
    const save = h.save.getMockImplementation()!;
    h.save.mockImplementationOnce((...args: unknown[]) => { save(...(args as [])); h.sessions.revokeByHandle(handle); });   // the new policy ends it
    expect((await h.request("PUT", WEB, { guests: { grants: { "dc:111": { instances: ["a"] } } } })).status).toBe(200);
    expect(h.note.mock.calls.map((c) => [c[0].by, c[0].via, c[0].removed])).toEqual([[`session:${handle}`, "direct", ["b"]]]);
  });
  it("the audit an admin reads comes with the section's own list: an admin's, never over the public link (a guest: see enforcement)", async () => {
    const h = harness({ web: { guests: { enabled: true } } });
    const mine = await h.request("GET", "/api/settings/guests");
    expect([mine.status, mine.body.audit?.[0]?.removed]).toEqual([200, ["a"]]);
    // A guest's request never reaches this handler: the fleet's guest gate (GUEST_ROUTES, default deny) refuses it first —
    // guest-grants-enforcement-2348 asks /api/settings/guests through the real listener as a guest (403).
    expect((await h.request("GET", "/api/settings/guests", undefined, { publicLink: true })).status).toBe(403);
  });
  it("a new grant for someone not seen in chat (or a fleet admin) is refused when it would apply; nothing is written", async () => {
    const h = harness({ web: { guests: { enabled: true, grants: {} } } });
    const add = await h.request("PUT", WEB, { guests: { grants: { "dc:999": { instances: ["a"] } } } });
    expect(add.status).toBe(202);
    const decided = await h.store.decide(add.body.pending_change.id, "confirm", confirmer());
    expect(decided.state).not.toBe("applied");
    expect(h.raw().web.guests.grants).toEqual({});
    expect(h.refusal).toHaveBeenCalledWith("dc", "999");
    // One already granted may be edited whatever the list says now (it was checked when granted).
    const g = harness({ web: { guests: { enabled: true, grants: { "dc:999": { instances: ["a", "b"] } } } } });
    expect((await g.request("PUT", WEB, { guests: { grants: { "dc:999": { instances: ["a"] } } } })).status).toBe(200);
    expect(g.refusal).not.toHaveBeenCalled();
  });
  it("the people list and Send sign-in code: an admin's (with who asked), never a guest's, never over the public link", async () => {
    const h = harness({ web: { guests: { enabled: true } } });
    expect(await h.request("GET", "/api/settings/guests/people")).toEqual({ status: 200, body: { people: [{ adapterId: "dc", userId: "111", username: "ada" }] } });
    const sent = await h.request("POST", "/api/settings/guests/send-code", { adapterId: "dc", userId: "111" });
    expect(sent).toEqual({ status: 200, body: { ok: true, outcome: "sent" } });
    expect(h.sendCode.mock.calls[0]![0]).toEqual({ adapterId: "dc", userId: "111" });
    expect(h.sendCode.mock.calls[0]![1]).toMatch(/^session:/);
    expect((await h.request("POST", "/api/settings/guests/send-code", { adapterId: "dc" })).status).toBe(400);
    for (const as of ["guest", "none"] as const) {
      expect((await h.request("GET", "/api/settings/guests/people", undefined, { as })).status, as).toBe(401);
      expect((await h.request("POST", "/api/settings/guests/send-code", { adapterId: "dc", userId: "111" }, { as })).status, as).toBe(401);
    }
    expect((await h.request("GET", "/api/settings/guests/people", undefined, { publicLink: true })).status).toBe(403);
    expect((await h.request("POST", "/api/settings/guests/send-code", { adapterId: "dc", userId: "111" }, { publicLink: true })).status).toBe(403);
    expect(h.sendCode).toHaveBeenCalledTimes(1);
    // #2365 review: the route hands down a check of that admin's session as it is now.
    const still = (h.sendCode.mock.calls[0] as unknown[])[2] as () => boolean;
    expect(still()).toBe(true);
    h.sessions.revokeAll(() => true);
    expect(still()).toBe(false);
  });
});

describe("seen_people: who wrote in chat", () => {
  it("written from a platform sender's receipt (never the web's); newest first; instances most recent first; pruned by last seen", () => {
    const dir = tmp("agend-2348-seen-");
    const outbox = new DeliveryOutbox(join(dir, "outbox.db"), "boot"); outboxes.push(outbox);
    const receipt = (origin: Record<string, unknown>, instance: string) => outbox.createHumanReceipt({ targetInstance: instance, originalBody: "hi", inputKind: "fleet_inbound", managerBootId: "boot",
      origin: { adapter_id: null, user_id: null, username: null, platform_message_id: null, ingress: "message", ...origin } as never });
    receipt({ platform: "discord", adapter_id: "dc", user_id: "111", username: "ada", platform_message_id: "m1" }, "a");
    receipt({ platform: "discord", adapter_id: "dc", user_id: "111", username: "ada_l", platform_message_id: "m2" }, "b");
    receipt({ platform: "telegram", adapter_id: "tg", user_id: "555", username: "mei", platform_message_id: "m3" }, "a");
    receipt({ platform: "web", ingress: "web" }, "a");
    const people = outbox.seenPeople();
    expect(people.map((p) => [p.adapterId, p.userId, p.username, p.instances.map((i) => i.name)])).toEqual([
      ["tg", "555", "mei", ["a"]], ["dc", "111", "ada_l", ["b", "a"]]]);
    expect([outbox.isSeenPerson("dc", "111"), outbox.isSeenPerson("dc", "999")]).toEqual([true, false]);
  });
  it("backfilled once from the receipts still kept, when the table is new; an older message never overwrites a newer handle", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE human_delivery_receipts (target_instance TEXT, origin_json TEXT, created_at TEXT)");
    const ins = db.prepare("INSERT INTO human_delivery_receipts VALUES (?, ?, ?)");
    ins.run("a", JSON.stringify({ platform: "discord", adapter_id: "dc", user_id: "111", username: "new" }), "2026-10-20T02:00:00Z");
    ins.run("b", JSON.stringify({ platform: "discord", adapter_id: "dc", user_id: "111", username: "old" }), "2026-10-19T02:00:00Z");
    ins.run("a", JSON.stringify({ platform: "web", adapter_id: null, user_id: null }), "2026-10-20T03:00:00Z");
    ins.run("a", "not json", "2026-10-20T04:00:00Z");
    initializeSeenPeople(db);
    expect(listSeenPeople(db).map((p) => [p.userId, p.username, p.firstSeen, p.lastSeen, p.instances.map((i) => i.name)]))
      .toEqual([["111", "new", "2026-10-19T02:00:00Z", "2026-10-20T02:00:00Z", ["a", "b"]]]);
    noteSeenPerson(db, { adapterId: "dc", userId: "111", username: "older", instance: "c", at: "2026-10-01T00:00:00Z" });
    expect(listSeenPeople(db)[0]!.username).toBe("new");
    initializeSeenPeople(db);                                                  // not new: no second backfill
    expect(pruneSeenPeople(db, "2026-10-21T00:00:00Z")).toBe(1);
    expect(listSeenPeople(db)).toEqual([]);
    db.close();
  });
});

const fleetAdapter = (s: any) => s.adapters.get("dc");
/** A real FleetManager on a scratch home: one Discord connection with a stubbed adapter (no network, no real DM). */
function fleet() {
  const dir = tmp("agend-2348-fm-");
  const fm = new FleetManager(dir), s = fm as any;
  const dms: Array<{ user: string; text: string }> = [];
  let failDm: Error | null = null;
  const adapter = { id: "dc", type: "discord", sendDirect: vi.fn(async (user: string, text: string) => { if (failDm) throw failDm; dms.push({ user, text }); return { chatId: user, messageId: `dm-${dms.length}` }; }),
    sendText: vi.fn(async () => ({ messageId: "x" })), stop: vi.fn(async () => {}) };
  const channel = { id: "dc", type: "discord", group_id: "G", bot_token_env: "X", access: { mode: "pairing", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel, channels: [channel], instances: { a: { working_directory: dir, topic_id: "T1", channel_id: "dc" }, b: { working_directory: dir, topic_id: "T2", channel_id: "dc" } },
    web: { guests: { enabled: true, grants: { "dc:111": { instances: ["a"] } } } } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("dc", adapter);
  s.worlds.set("dc", { id: "dc", adapter, groupId: "G", channelConfig: channel, accessManager: { isAllowed: () => true, getMode: () => "pairing" }, stop: async () => {} });
  s.classicChannels = { getAll: () => [] };
  writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebAuthTokens?.(); s.initializeWebSessions();
  const outbox = new DeliveryOutbox(join(dir, "outbox.db"), "boot"); outboxes.push(outbox); s.deliveryOutbox = outbox;
  outbox.createHumanReceipt({ targetInstance: "a", originalBody: "hi", inputKind: "fleet_inbound", managerBootId: "boot",
    origin: { platform: "discord", adapter_id: "dc", user_id: "111", username: "ada", platform_message_id: "m1", ingress: "message" } });
  outbox.createHumanReceipt({ targetInstance: "b", originalBody: "hi", inputKind: "fleet_inbound", managerBootId: "boot",
    origin: { platform: "discord", adapter_id: "dc", user_id: "admin", username: "boss", platform_message_id: "m2", ingress: "message" } });
  return { fm, s, adapter, dms, failWith: (e: Error | null) => { failDm = e; } };
}

describe("on a real FleetManager", () => {
  it("the people list leaves out fleet admins; a grant is refused for an admin, someone unseen, or an unknown connection", () => {
    const { s } = fleet();
    expect(s.guestPeople().people.map((p: any) => [p.userId, p.platform, p.instances])).toEqual([["111", "discord", ["a"]]]);
    expect(s.guestGrantRefusal("dc", "111")).toBeNull();
    expect(s.guestGrantRefusal("dc", "admin")).toMatch(/fleet admin/);
    expect(s.guestGrantRefusal("dc", "999")).toMatch(/seen in chat/);
    expect(s.guestGrantRefusal("nowhere", "111")).toMatch(/no such connection/);
  });
  it("#2499 review: the audit reaches the admin — Settings → Guests' list reads the grant changes and the codes sent, newest first", async () => {
    const { s } = fleet();
    s.eventLog = new EventLog(join(tmp("agend-2499-ev-"), "events.db"));
    expect(s.guestOverview().audit, "nothing yet").toEqual([]);
    s.noteGuestGrantChange({ by: "session:A", via: "confirmed", account: "dc:111", added: ["a"], removed: [], endedSessions: 0 });
    expect((await s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "111" }, "session:A")).body.outcome).toBe("sent");
    s.noteGuestGrantChange({ by: "session:A", via: "direct", account: "dc:111", added: [], removed: ["a"], endedSessions: 2 });
    const audit = s.guestOverview().audit;
    expect(audit.map((e: any) => [e.kind, e.account, e.via ?? e.outcome, e.added ?? null, e.removed ?? null, e.endedSessions ?? null])).toEqual([
      ["grant", "dc:111", "direct", [], ["a"], 2], ["code", "dc:111", "sent", null, null, null], ["grant", "dc:111", "confirmed", ["a"], [], 0]]);
    expect(audit.every((e: any) => typeof e.name === "string" && e.name.length > 0 && Number.isFinite(e.at) && !("by" in e)), "a name and a time; no session handle").toBe(true);
    s.eventLog.close();
  });
  // #2499 r2 (Prism P2): created_at is to the second. Rows written in one second keep their order (the row id), so a newer
  // code after 20 grant changes in the same second is the first line, never the one the cap drops.
  it("#2499 r2: the newest 20 in insertion order, even when they share one second — a newer code is never cut at the cap", () => {
    const { s } = fleet();
    s.eventLog = new EventLog(join(tmp("agend-2499-ev-"), "events.db"));
    for (let i = 0; i < 25; i++) s.noteGuestGrantChange({ by: null, via: "direct", account: "dc:111", added: [`n${i}`], removed: [], endedSessions: 0 });
    s.eventLog.insert("fleet", "guest_code_sent", { by: "session:A", account: "dc:111", outcome: "sent", instances: 1 });
    s.eventLog.insert("fleet", "instance_paused", { account: "dc:111" });                     // another fleet row: never in the list
    const at = new Set((s.eventLog.query({ instance: "fleet", limit: 100 }) as Array<{ created_at: string }>).map((r) => r.created_at));
    const audit = s.guestOverview().audit;
    expect([audit.length, audit[0].kind, audit[1].added, audit[19].added]).toEqual([20, "code", ["n24"], ["n6"]]);
    expect(at.size <= 2, "the rows share a second (or straddle one)").toBe(true);
    s.eventLog.close();
  });
  it("#2499 r2: insertion order, not the clock — a row stamped later (a clock stepped back since) is not put first", () => {
    const { s } = fleet();
    s.eventLog = new EventLog(join(tmp("agend-2499-ev-"), "events.db"));
    (s.eventLog as any).db.prepare("INSERT INTO events (instance_name, event_type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run("fleet", "guest_code_sent", JSON.stringify({ account: "dc:111", outcome: "sent" }), "2099-01-01 00:00:00");
    s.noteGuestGrantChange({ by: null, via: "direct", account: "dc:111", added: [], removed: ["a"], endedSessions: 0 });
    expect(s.guestOverview().audit.map((e: any) => e.kind)).toEqual(["grant", "code"]);
    s.eventLog.close();
  });
  it("#2348 delta §5: a grant change goes to the event log as guest_grant_changed: who, how, which agents", () => {
    const { s } = fleet();
    const insert = vi.fn(); s.eventLog = { insert };
    const change = { by: "session:A", via: "direct" as const, account: "dc:111", added: [], removed: ["a"], endedSessions: 2 };
    s.noteGuestGrantChange(change);
    expect(insert.mock.calls).toEqual([["fleet", "guest_grant_changed", change]]);
    s.eventLog = { insert: () => { throw new Error("disk full"); } };
    expect(() => s.noteGuestGrantChange(change), "a failed log write never fails the save").not.toThrow();
  });
  it("Send sign-in code: a DM to that person only (the intro, then the code alone); once a minute per person", async () => {
    const { s, dms, adapter } = fleet();
    const first = await s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "111" }, "session:A");
    expect([first.status, first.body.outcome, typeof first.body.expiresAt]).toEqual([200, "sent", "number"]);
    expect(dms.map((d) => d.user)).toEqual(["111", "111"]);
    expect(dms[1]!.text).toMatch(/\b[A-Z0-9]{4}[- ]?[A-Z0-9]{4}\b|\d{6,}/);
    expect(adapter.sendText).not.toHaveBeenCalled();                                   // nothing posted anywhere
    const again = await s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "111" }, "session:A");
    expect([again.status, again.body.outcome]).toEqual([429, "wait"]);
    const o = s.guestOverview().guests.find((g: any) => g.userId === "111");
    expect([o.grant, o.code.outcome]).toEqual([{ instances: ["a"] }, "sent"]);
  });
  it("refused: guests off, a fleet admin, nothing granted; a failed DM says why and leaves no code behind", async () => {
    const { s, fm, failWith } = fleet();
    expect((await s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "admin" }, "session:A")).body.outcome).toBe("admin");
    expect((await s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "999" }, "session:A")).body.outcome).toBe("nothing");
    (fm.fleetConfig as any).web.guests.enabled = false;
    expect((await s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "111" }, "session:A")).body.outcome).toBe("guests_off");
    (fm.fleetConfig as any).web.guests.enabled = true;
    failWith(Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }));
    s.initializeWebSessions();
    const revoked = vi.spyOn(s.webGuestLoginCodes, "revokeIfCurrent");
    const failed = await s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "111" }, "session:A");
    expect([failed.status, failed.body.outcome, failed.body.platform, failed.body.reason]).toEqual([502, "dm_failed", "discord", "Cannot send messages to this user"]);
    expect(revoked, "the undelivered code is withdrawn").toHaveBeenCalledTimes(1);
    expect(fleetAdapter(s).sendText, "and nothing is posted anywhere instead").not.toHaveBeenCalled();
  });
  it("#2365 review: the admin's session ended while the room read was held — no code is made, none sent; control: still signed in, sent", async () => {
    for (const stays of [false, true]) {
      const { s, dms } = fleet();
      let release!: () => void;
      s.refreshGuestRooms = () => new Promise<void>((r) => { release = r; });
      s.initializeWebSessions();
      const issued = vi.spyOn(s.webGuestLoginCodes, "issue");
      let allowed = true;
      const pending = s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "111" }, "session:A", () => allowed);
      await new Promise((r) => setTimeout(r, 0));
      if (!stays) allowed = false;                                              // the admin signed out meanwhile
      release();
      const out = await pending;
      if (stays) expect([out.status, out.body.outcome, dms.length]).toEqual([200, "sent", 2]);
      else expect([out.status, out.body.outcome, dms.length, issued.mock.calls.length]).toEqual([401, "revoked", 0, 0]);
    }
  });
  it("#2365 review: the admin's session ended while the DM was held — the code is withdrawn, the code-alone message never sent", async () => {
    for (const stays of [false, true]) {
      const { s, dms, adapter } = fleet();
      let release!: () => void;
      const real = adapter.sendDirect.getMockImplementation()!;
      adapter.sendDirect.mockImplementationOnce(async (user: string, text: string) => { await new Promise<void>((r) => { release = r; }); return real(user, text); });
      s.initializeWebSessions();
      const withdrawn = vi.spyOn(s.webGuestLoginCodes, "revokeIfCurrent");
      let allowed = true;
      const pending = s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "111" }, "session:A", () => allowed);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      if (!stays) allowed = false;
      release();
      const out = await pending;
      if (stays) expect([out.status, out.body.outcome, dms.length, withdrawn.mock.calls.length]).toEqual([200, "sent", 2, 0]);
      else expect([out.status, out.body.outcome, dms.length, withdrawn.mock.calls.length]).toEqual([401, "revoked", 1, 1]);
    }
  });
  it("one admin may send at most 10 codes in 10 minutes", async () => {
    const { s, fm } = fleet();
    const grants: Record<string, { instances: string[] }> = {};
    for (let i = 0; i < 11; i++) grants[`dc:${1000 + i}`] = { instances: ["a"] };
    (fm.fleetConfig as any).web.guests.grants = grants;
    const outcomes: string[] = [];
    for (let i = 0; i < 11; i++) outcomes.push((await s.sendGuestCodeByAdmin({ adapterId: "dc", userId: String(1000 + i) }, "session:A")).body.outcome);
    expect(outcomes.slice(0, 10).every((o) => o !== "admin_limit")).toBe(true);
    expect(outcomes[10]).toBe("admin_limit");
    expect((await s.sendGuestCodeByAdmin({ adapterId: "dc", userId: "1010" }, "session:B")).body.outcome, "another admin's own budget").not.toBe("admin_limit");
  });
});
