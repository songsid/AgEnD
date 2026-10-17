/**
 * #1920 phase 2 (step 1): a guest's scope is derived on every request from the account's chat access, and a guest
 * session lives by its own policy and caps.
 * - Scope (§3): nothing while web.guests is off; a connection that lets the account in gives its fleet topics and its
 *   General (never another connection's, never a ClassicBot room through it); an `open` connection gives only what an
 *   admin named for its guests; the account's own Telegram private room; then an admin's narrowing, which only takes
 *   away.
 * - An emptied scope ends the session (§3.5); turning guests off ends every guest session, wherever the config changes.
 * - Sessions (§5.4): 12 h / 2 h by default, never longer than the surface's policy; guests never evict an admin.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-1920-scope-"));
process.env.AGEND_HOME = home;                         // before the fleet's modules load (pino's daemon.log)

const { FleetManager } = await import("../src/fleet-manager.js");
const { GUEST_SESSION_POLICY, guestSessionPolicy, MAX_GUEST_SESSIONS, MAX_GUEST_SESSIONS_PER_ACCOUNT, MAX_WEB_SESSIONS, tokenEpoch, WebSessionStore } = await import("../src/web-session.js");
const { validateFleetConfig } = await import("../src/config-validator.js");

afterAll(() => rmSync(home, { recursive: true, force: true }));

const HOUR = 3_600_000, MINUTE = 60_000;
const EPOCH = "e".repeat(64);
const ALICE = { adapterId: "dc", userId: "111111111111111111" };
const TG_ALICE = { adapterId: "tg", userId: "5550001" };

type Mode = "open" | "pairing" | "locked";
function fleet(opts: { enabled?: boolean; modes?: Record<string, Mode>; allowed?: Record<string, string[]>; guests?: Record<string, unknown>; rooms?: Array<{ channelId: string; adapterId: string; instanceName: string }> } = {}) {
  const fm: any = new FleetManager(home);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.fleetConfig = {
    channels: [{ id: "dc", type: "discord" }, { id: "tg", type: "telegram" }],
    instances: {
      general: { general_topic: true, channel_id: "dc" }, a: { channel_id: "dc" }, b: { channel_id: "dc" },
      "tg-general": { general_topic: true, channel_id: "tg" }, t: { channel_id: "tg" }, room: { channel_id: "tg" },
    },
    web: { guests: { enabled: opts.enabled ?? true, ...opts.guests } },
  };
  for (const id of ["dc", "tg"]) {
    const mode = opts.modes?.[id] ?? "locked";
    const allowed = new Set(opts.allowed?.[id] ?? []);
    fm.worlds.set(id, { id, accessManager: { getMode: () => mode, isAllowed: (u: string) => mode === "open" || allowed.has(u) } });
  }
  fm.classicChannels = { getAll: () => opts.rooms ?? [], getChannelIdByInstance: () => undefined, getAdapterIdByInstance: () => undefined };
  return fm;
}
const names = (s: ReadonlySet<string>) => [...s].sort();

describe("guestScope: derived from the account's chat access, every time", () => {
  it("off (the default): nothing, whatever the access", () => {
    const fm = fleet({ enabled: false, allowed: { dc: [ALICE.userId] } });
    expect(fm.guestScope(ALICE).size).toBe(0);
    fm.fleetConfig.web = {};
    expect(fm.guestScope(ALICE).size).toBe(0);
  });
  it("a connection that lets the account in: its fleet topics and its General — not the other connection's", () => {
    const fm = fleet({ allowed: { dc: [ALICE.userId] } });
    expect(names(fm.guestScope(ALICE))).toEqual(["a", "b", "general"]);
    expect(fm.guestScope({ adapterId: "dc", userId: "999" }).size, "not in its access").toBe(0);
    expect(fm.guestScope({ adapterId: "tg", userId: ALICE.userId }).size, "the same number on another connection is someone else").toBe(0);
    expect(fm.guestScope({ adapterId: "nowhere", userId: ALICE.userId }).size).toBe(0);
    expect(fm.guestScope(undefined).size).toBe(0);
  });
  it("removed from the access: the next ask has nothing (it is never stored)", () => {
    const allowed = { dc: [ALICE.userId] };
    const fm = fleet({ allowed });
    expect(fm.guestScope(ALICE).size).toBe(3);
    fm.worlds.get("dc").accessManager.isAllowed = () => false;
    expect(fm.guestScope(ALICE).size).toBe(0);
  });
  it("an open connection: only the instances an admin named for its guests, and only that connection's", () => {
    const fm = fleet({ modes: { dc: "open" } });
    expect(fm.guestScope(ALICE).size, "nothing until named (the user's decision)").toBe(0);
    fm.fleetConfig.web.guests.open_instances = { dc: ["a", "t", "nope"] };
    expect(names(fm.guestScope(ALICE))).toEqual(["a"]);
    fm.fleetConfig.web.guests.open_instances = { tg: ["t"] };
    expect(fm.guestScope(ALICE).size, "another connection's list is not this one's").toBe(0);
    fm.fleetConfig.web.guests.open_instances = Object.create({ dc: ["a"] });
    expect(fm.guestScope(ALICE).size, "own keys only").toBe(0);
  });
  it("a ClassicBot room: the account's own Telegram private room only — never someone else's, never a group", () => {
    const rooms = [
      { channelId: TG_ALICE.userId, adapterId: "tg", instanceName: "room" },
      { channelId: "5550002", adapterId: "tg", instanceName: "bobs-room" },
      { channelId: "-1001234", adapterId: "tg", instanceName: "group-room" },
    ];
    const fm = fleet({ rooms });
    expect(names(fm.guestScope(TG_ALICE))).toEqual(["room"]);
    expect(fm.guestScope({ adapterId: "dc", userId: TG_ALICE.userId }).size, "on its own connection only").toBe(0);
    const discord = fleet({ rooms: [{ channelId: ALICE.userId, adapterId: "dc", instanceName: "room" }] });
    expect(discord.guestScope(ALICE).size, "a private room is Telegram's; a Discord channel never is one person's").toBe(0);
  });
  it("a ClassicBot instance never comes in through its connection's access", () => {
    const fm = fleet({ allowed: { tg: [TG_ALICE.userId] }, rooms: [{ channelId: "-1009", adapterId: "tg", instanceName: "room" }] });
    fm.isClassicInstance = (n: string) => n === "room";
    expect(names(fm.guestScope(TG_ALICE))).toEqual(["t", "tg-general"]);
  });
  it("an admin's narrowing only takes away", () => {
    const fm = fleet({ allowed: { dc: [ALICE.userId] }, guests: { narrow: { [`dc:${ALICE.userId}`]: ["a", "t", "zzz"] } } });
    expect(names(fm.guestScope(ALICE))).toEqual(["a"]);
    fm.fleetConfig.web.guests.narrow = { [`dc:${ALICE.userId}`]: [] };
    expect(fm.guestScope(ALICE).size).toBe(0);
    fm.fleetConfig.web.guests.narrow = { "dc:someone-else": [] };
    expect(fm.guestScope(ALICE).size).toBe(3);
  });
});

describe("an emptied scope or guests turned off ends guest sessions (§3.5)", () => {
  function withSessions(fm: any) {
    fm.initializeWebAuthTokens();                      // the scratch home's own web.token
    fm.webSessions = new WebSessionStore();
    const admin = fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.webToken) }).record;
    const guest = fm.webSessions.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: tokenEpoch(fm.webToken), owner: ALICE }).record;
    return { admin, guest };
  }
  it("a guest with something in scope stays; with nothing, its session is revoked and stays gone", () => {
    const fm = fleet({ allowed: { dc: [ALICE.userId] } });
    const { admin, guest } = withSessions(fm);
    expect(fm.guestStillAdmitted(guest)).toBe(true);
    fm.fleetConfig.web.guests.narrow = { [`dc:${ALICE.userId}`]: [] };
    expect(fm.guestStillAdmitted(guest)).toBe(false);
    fm.fleetConfig.web.guests.narrow = {};
    expect(fm.guestStillAdmitted(guest), "revoked, not paused").toBe(false);
    expect(fm.webSessions.isCurrent(admin, tokenEpoch(fm.webToken)), "an admin's session is untouched").toBe(true);
  });
  it("turning guests off ends every guest session when the config is saved — turning it back on revives none", () => {
    const fm = fleet({ allowed: { dc: [ALICE.userId] } });
    const { admin, guest } = withSessions(fm);
    fm.configPath = null;                               // the save itself has nothing to write here
    fm.fleetConfig.web.guests.enabled = false;
    fm.saveFleetConfig();
    fm.fleetConfig.web.guests.enabled = true;
    expect(fm.guestStillAdmitted(guest)).toBe(false);
    expect(fm.webSessions.list().map((s: { tier: string }) => s.tier)).toEqual(["admin"]);
    expect(fm.webSessions.isCurrent(admin, tokenEpoch(fm.webToken))).toBe(true);
  });
  it("#2082 review: the fleet starting with guests off ends the guest sessions kept on disk — turning guests on later revives none", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1920-start-"));
    try {
      const before: any = new FleetManager(dir);
      const q = () => {}; before.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => before.logger };
      before.fleetConfig = { instances: {}, web: { guests: { enabled: true } } };
      before.initializeWebAuthTokens();
      const epoch = tokenEpoch(before.webToken);
      const { sessionId } = before.webSessions.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: epoch, owner: ALICE });
      before.webSessions.create({ tier: "admin", surface: "local", label: "a", tokenEpoch: epoch });
      // A new process: its config says guests are off when it opens the sessions kept on disk (before any guest asks).
      const after: any = new FleetManager(dir);
      after.logger = before.logger;
      after.fleetConfig = { instances: {}, web: { guests: { enabled: false } } };
      after.initializeWebAuthTokens();
      after.fleetConfig.web.guests.enabled = true;
      expect(after.webSessions.authenticate(sessionId, epoch, { touch: false })).toBeNull();
      expect(after.webSessions.list().map((s: { tier: string }) => s.tier)).toEqual(["admin"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("…and when the config is read again (a reload with guests off)", () => {
    const fm = fleet({ allowed: { dc: [ALICE.userId] } });
    const { guest } = withSessions(fm);
    const dir = mkdtempSync(join(tmpdir(), "agend-1920-cfg-"));
    try {
      const path = join(dir, "fleet.yaml");
      writeFileSync(path, "instances:\n  a: {}\nweb:\n  guests:\n    enabled: false\n");
      fm.loadConfig(path);
      expect(fm.webSessions.isCurrent(guest, tokenEpoch(fm.webToken))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("a guest's session: its own policy and its own room (§5.4)", () => {
  it("12 h absolute / 2 h idle by default; never longer than the surface's (the public link's 4 h / 30 min wins)", () => {
    let now = 1_000_000;
    const s = new WebSessionStore({ now: () => now });
    const local = s.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: EPOCH, owner: ALICE }).record;
    expect([local.absoluteExpiry - now, local.idleExpiry - now]).toEqual([12 * HOUR, 2 * HOUR]);
    const gw = s.create({ tier: "guest", surface: "gateway", label: "g", tokenEpoch: EPOCH, owner: ALICE, exposureId: "a".repeat(32) }).record;
    expect([gw.absoluteExpiry - now, gw.idleExpiry - now]).toEqual([4 * HOUR, 30 * MINUTE]);
    const admin = s.create({ tier: "admin", surface: "local", label: "a", tokenEpoch: EPOCH }).record;
    expect(admin.absoluteExpiry - now, "an admin's is unchanged").toBe(48 * HOUR);
    const short = new WebSessionStore({ now: () => now, localPolicy: () => ({ absoluteMs: 1 * HOUR, idleMs: 1 * HOUR }) });
    const g = short.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: EPOCH, owner: ALICE }).record;
    expect([g.absoluteExpiry - now, g.idleExpiry - now], "a shorter local policy wins").toEqual([1 * HOUR, 1 * HOUR]);
  });
  it("web.guests.session, read at every check; shortening applies to existing guest sessions", () => {
    let now = 1_000_000, cfg: { absolute_hours?: number; idle_minutes?: number } = {};
    const s = new WebSessionStore({ now: () => now, guestPolicy: () => guestSessionPolicy(cfg) });
    const { sessionId, record } = s.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: EPOCH, owner: ALICE });
    cfg = { idle_minutes: 15 };
    now += 16 * MINUTE;
    expect(s.authenticate(sessionId, EPOCH), "idle past the new 15 min").toBeNull();
    expect(s.isCurrent(record, EPOCH)).toBe(false);
  });
  it("guestSessionPolicy: defaults, bounds, idle never past absolute; nonsense never loosens", () => {
    expect(guestSessionPolicy(undefined)).toEqual(GUEST_SESSION_POLICY);
    expect(guestSessionPolicy({ absolute_hours: 24, idle_minutes: 720 })).toEqual({ absoluteMs: 24 * HOUR, idleMs: 12 * HOUR });
    expect(guestSessionPolicy({ absolute_hours: 0.1, idle_minutes: 1 })).toEqual({ absoluteMs: 1 * HOUR, idleMs: 15 * MINUTE });
    expect(guestSessionPolicy({ absolute_hours: 1, idle_minutes: 600 })).toEqual({ absoluteMs: 1 * HOUR, idleMs: 1 * HOUR });
    expect(guestSessionPolicy({ absolute_hours: 999, idle_minutes: "x" as never })).toEqual(GUEST_SESSION_POLICY);
  });
  it("all guests together: at most 64 (the least recently used of them goes), and still no admin", () => {
    let now = 1_000;
    const s = new WebSessionStore({ now: () => now++ });
    const admin = s.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: EPOCH }).record;
    for (let i = 0; i < MAX_GUEST_SESSIONS + 1; i++) s.create({ tier: "guest", surface: "local", label: `g${i}`, tokenEpoch: EPOCH, owner: { adapterId: "dc", userId: String(i) } });
    const labels = s.list().map((x) => x.label);
    expect(labels.filter((l) => l.startsWith("g")).length).toBe(MAX_GUEST_SESSIONS);
    expect(labels).not.toContain("g0");
    expect(s.isCurrent(admin, EPOCH)).toBe(true);
  });
  it("guests never push an admin out; one account keeps at most four; a reload keeps the same caps", () => {
    let now = 1_000;
    const dir = mkdtempSync(join(tmpdir(), "agend-1920-caps-"));
    try {
      const s = new WebSessionStore({ now: () => now++, dataDir: dir });
      const admins = Array.from({ length: MAX_WEB_SESSIONS }, (_, i) => s.create({ tier: "admin", surface: "local", label: `a${i}`, tokenEpoch: EPOCH }).record);
      for (let i = 0; i < 10; i++) s.create({ tier: "guest", surface: "local", label: `g${i}`, tokenEpoch: EPOCH, owner: ALICE });
      s.create({ tier: "guest", surface: "local", label: "bob", tokenEpoch: EPOCH, owner: { adapterId: "dc", userId: "2" } });
      const list = (st: InstanceType<typeof WebSessionStore>) => st.list().map((x) => x.label).sort();
      const want = [...admins.map((a) => a.label), "bob", "g6", "g7", "g8", "g9"].sort();
      expect(list(s)).toEqual(want);
      expect(want.filter((l) => l.startsWith("g")).length).toBe(MAX_GUEST_SESSIONS_PER_ACCOUNT);
      expect(list(new WebSessionStore({ now: () => now, dataDir: dir }))).toEqual(want);
      s.create({ tier: "admin", surface: "local", label: "a-new", tokenEpoch: EPOCH });
      expect(list(s).filter((l) => l.startsWith("a")).length, "admins keep their own cap").toBe(MAX_WEB_SESSIONS);
      expect(list(s)).toContain("bob");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("web.guests in fleet.yaml", () => {
  const check = (guests: unknown) => validateFleetConfig({ instances: { a: {}, b: {} }, web: { guests } } as never);
  const paths = (r: { errors: Array<{ path: string }> }) => r.errors.map((e) => e.path);
  it("the keys, their types and the session bounds", () => {
    expect(check({ enabled: true, chat: false, open_instances: { dc: ["a"] }, narrow: { "dc:123": ["b"] }, session: { absolute_hours: 12, idle_minutes: 120 } }).errors).toEqual([]);
    expect(paths(check({ enabled: "yes", chat: 1, lasers: true }))).toEqual(["web.guests.lasers", "web.guests.enabled", "web.guests.chat"]);
    expect(paths(check({ open_instances: { dc: "a" }, narrow: { nouser: ["a"] } }))).toEqual(["web.guests.open_instances.dc", "web.guests.narrow.nouser"]);
    expect(paths(check({ session: { absolute_hours: 25 } }))).toEqual(["web.guests.session.absolute_hours"]);
    expect(paths(check({ session: { idle_minutes: 14 } }))).toEqual(["web.guests.session.idle_minutes"]);
    expect(paths(check({ session: { absolute_hours: 1, idle_minutes: 61 } }))).toEqual(["web.guests.session.idle_minutes"]);
    expect(paths(check({ session: { idle_minutes: 720 } })), "12 h idle within the default 12 h").toEqual([]);
    expect(paths(check({ session: { gateway: {} } }))).toEqual(["web.guests.session.gateway"]);
  });
  it("a name that is not an instance of this fleet is a warning (it gives nothing)", () => {
    const r = check({ open_instances: { dc: ["a", "ghost"] } });
    expect([r.errors, r.warnings.filter((w: { path: string }) => w.path.startsWith("web.guests")).map((w: { path: string; message: string }) => w.message)])
      .toEqual([[], [expect.stringContaining("\"ghost\"")]]);
  });
});
