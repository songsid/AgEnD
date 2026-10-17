/**
 * #1920 phase 2 (step 4b-2, §5.4): a guest's returning devices.
 * - A guest's sign-in makes the browser a guest's returning device: counted apart (4 per account, 64 in all), so a
 *   guest never pushes an admin's device out, nor the reverse.
 * - Its "send me a code" is a guest code for that account, by DM, under the rules of its /web (guests on, not an
 *   admin, something in scope; one code per account and the cap; one flow per account at a time; a revoke meanwhile
 *   ends it), with its own limiter (guests never use up the admins' fleet-wide budget) — the dashboard reached directly
 *   only, for now.
 * - A guest's /web revoke forgets its devices; guest sign-in turned off forgets every guest's; an admin's revoke, all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { tokenEpoch } from "../src/web-session.js";
import { setLocale } from "../src/locale.js";
import { MAX_GUEST_RETURNING_DEVICES, MAX_RETURNING_DEVICES, ReturningDevices } from "../src/web-returning-device.js";

const TOKEN = "c".repeat(48);
const input = { surface: "local" as const, label: "Firefox", tokenEpoch: tokenEpoch(TOKEN), webToken: TOKEN };
const value = (cookie: string) => cookie;

describe("ReturningDevices: guests' devices", () => {
  it("counted apart: guests never push an admin's device out, nor the reverse; 4 per account, 64 in all", () => {
    let now = 0;
    const devices = new ReturningDevices({ now: () => ++now });
    const admins = Array.from({ length: MAX_RETURNING_DEVICES }, (_, i) => devices.remember({ adapterId: "o", userId: "admin", chatId: "G", threadId: `T${i}` }, input));
    const alice = Array.from({ length: 6 }, () => devices.rememberGuest({ adapterId: "o", userId: "alice" }, input));
    const verify = (v: string) => devices.verify(value(v), TOKEN, tokenEpoch(TOKEN));
    expect(admins.every((v) => verify(v)), "no admin device pushed out").toBe(true);
    expect(alice.map((v) => !!verify(v)), "her oldest two went (4 per account)").toEqual([false, false, true, true, true, true]);
    expect(verify(alice[5]!)).toMatchObject({ tier: "guest", owner: { adapterId: "o", userId: "alice", chatId: "" } });
    const many = Array.from({ length: MAX_GUEST_RETURNING_DEVICES }, (_, i) => devices.rememberGuest({ adapterId: "o", userId: `g${i}` }, input));
    expect(alice.slice(2).some((v) => verify(v)), "the oldest guests' went first (64 in all)").toBe(false);
    expect(many.every((v) => verify(v))).toBe(true);
    expect(admins.every((v) => verify(v)), "still no admin device pushed out").toBe(true);
    devices.remember({ adapterId: "o", userId: "admin", chatId: "G" }, input);
    expect(verify(admins[0]!), "an admin's 17th pushes out the oldest admin's").toBeNull();
    expect(many.every((v) => verify(v)), "never a guest's").toBe(true);
  });
  it("revokeGuest: that account's guest devices, or every guest's — never an admin's; persisted with the tier", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1920d-"));
    try {
      const devices = new ReturningDevices({ dataDir: dir });
      const admin = devices.remember({ adapterId: "o", userId: "admin", chatId: "G" }, input);
      const a = devices.rememberGuest({ adapterId: "o", userId: "alice" }, input), b = devices.rememberGuest({ adapterId: "o", userId: "bob" }, input);
      const again = new ReturningDevices({ dataDir: dir });
      expect(again.verify(a, TOKEN, tokenEpoch(TOKEN))).toMatchObject({ tier: "guest" });
      expect(again.verify(admin, TOKEN, tokenEpoch(TOKEN))).not.toHaveProperty("tier");
      expect(devices.revokeGuest({ adapterId: "o", userId: "alice" })).toEqual({ count: 1, durable: true });
      expect([devices.verify(a, TOKEN, tokenEpoch(TOKEN)), !!devices.verify(b, TOKEN, tokenEpoch(TOKEN))]).toEqual([null, true]);
      expect(devices.revokeGuest()).toEqual({ count: 1, durable: true });
      expect(devices.verify(admin, TOKEN, tokenEpoch(TOKEN))).not.toBeNull();
      expect(new ReturningDevices({ dataDir: dir }).size, "and on disk").toBe(1);
      // A record with any other tier is no device at all (never read as an admin's).
      const file = join(dir, "web-devices.json");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.devices = raw.devices.map((d: any) => ({ ...d, tier: "admin" }));
      writeFileSync(file, JSON.stringify(raw));
      expect(new ReturningDevices({ dataDir: dir }).size).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const rigs: Array<{ dir: string; fm: FleetManager }> = [];
let mono = 0;
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1920d-"));
  const fm = new FleetManager(dir), s = fm as any;
  const adapter = { id: "owner", type: "discord", sendText: vi.fn(async (chat: string) => ({ chatId: chat, messageId: "safe" })),
    sendDirect: vi.fn(async (_user: string, _text: string, _opts?: any) => ({ chatId: "DM", messageId: "dm" })), stop: vi.fn(async () => {}) };
  const channel = { id: "owner", type: "discord", group_id: "G", bot_token_env: "NONE", access: { mode: "allowlist", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel, channels: [channel], web: { guests: { enabled: true } }, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
    worker: { working_directory: dir, topic_id: "T1", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: channel, accessManager: { isAllowed: () => true, getMode: () => "allowlist" }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false, getAll: () => [] };
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
  const respond = vi.fn(async (_text: string) => "slash");
  const slash = (user: string, action?: string) => s.dispatchSlash({ command: "web", guildId: "G", channelId: "T1", userId: user, username: user, options: { action }, respond, respondButtons: vi.fn(async () => "menu") }, "owner", adapter);
  const device = (user = "alice") => s.returningDevices.verify(s.rememberGuestDevice({ adapterId: "owner", userId: user }, { surface: "local", label: "Firefox" }), TOKEN, tokenEpoch(TOKEN));
  const ask = (d: any, extra: Record<string, unknown> = {}) => s.requestReturningCode(d, { surface: "local", label: "Firefox", ...extra });
  const h = { dir, fm, s, adapter, slash, device, ask }; rigs.push(h); return h;
}
beforeEach(() => { setLocale("en"); mono = 1_000_000; vi.spyOn(performance, "now").mockImplementation(() => mono); });
afterEach(() => {
  for (const h of rigs.splice(0)) { h.fm.stormWindow.shutdown(); h.fm.spawnGate.shutdown(); rmSync(h.dir, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});
const codeOf = (text: unknown) => /[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(String(text))![0];

describe("a guest's device asks for a code", () => {
  it("a guest code for that account, by DM; the admins' codes, limiter and devices untouched", async () => {
    const h = rig();
    const admin = h.s.issueDashboardLogin()!;
    const adminLimit = vi.spyOn(h.s.codeRequestLimiter, "admit");
    expect(await h.ask(h.device())).toEqual({ kind: "sent" });
    const [to, text] = h.adapter.sendDirect.mock.calls[0]!;
    expect(to).toBe("alice");
    expect(h.s.webGuestLoginCodes.match(codeOf(text), tokenEpoch(TOKEN))).toMatchObject({ kind: "ok", tier: "guest", recipient: { userId: "alice" } });
    expect(h.s.webLoginCodes.redeem(admin.display, tokenEpoch(TOKEN)), "the admin's code still stands").toMatchObject({ kind: "ok", tier: "admin" });
    expect(adminLimit, "guests' requests use their own limiter").not.toHaveBeenCalled();
  });
  it("refused: guest sign-in off, the account now an admin or out of scope, or through the public link (not yet)", async () => {
    const h = rig();
    const d = h.device();
    expect(await h.ask(d, { surface: "gateway", exposureId: "a".repeat(32) })).toEqual({ kind: "refused" });
    h.fm.fleetConfig!.web = { guests: { enabled: true, narrow: { "owner:alice": [] } } } as never;
    expect(await h.ask(d)).toEqual({ kind: "refused" });
    (h.fm.fleetConfig as any).channels[0].access.allowed_users.push("alice");
    h.fm.fleetConfig!.web = { guests: { enabled: true } } as never;
    expect(await h.ask(d), "now a fleet admin: not a guest's code").toEqual({ kind: "refused" });
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
  });
  it("its /web's rules: once a minute per account (with /web too), one flow at a time, the cap; the guests' breaker", async () => {
    const h = rig();
    const d = h.device();
    await h.slash("alice");                                                 // a code by /web
    expect(await h.ask(d)).toMatchObject({ kind: "limited" });
    mono += 60_000;
    let release!: () => void;
    h.adapter.sendDirect.mockImplementationOnce(() => new Promise((r) => { release = () => r({ chatId: "DM", messageId: "dm" }); }));
    const first = h.ask(d);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await h.ask(h.device()), "one flow per account at a time").toMatchObject({ kind: "limited" });
    release(); expect(await first).toEqual({ kind: "sent" });
    const codes = h.s.webGuestLoginCodes;
    for (let i = codes.size; i < 32; i++) codes.issue({ epoch: tokenEpoch(TOKEN), recipient: { adapterId: "owner", userId: `u${i}` } });
    mono += 60_000;
    expect(await h.ask(h.device("bob")), "the cap: refused for now, nobody evicted").toMatchObject({ kind: "limited" });
    mono += 60_000;                                                         // past the guests' limiter gaps
    codes.revokeAll(); codes.issue({ epoch: tokenEpoch(TOKEN), recipient: { adapterId: "owner", userId: "x" } });
    for (let i = 0; i < 20; i++) { codes.recordWrong("ZZZZ-ZZZZ"); if (!codes.size) codes.issue({ epoch: tokenEpoch(TOKEN), recipient: { adapterId: "owner", userId: "x" } }); }
    expect(await h.ask(h.device("carol")), "the guests' breaker").toMatchObject({ kind: "limited" });
  });
  it("one flow per account across both doors: a device asking while that account's /web reads its rooms waits", async () => {
    const h = rig();
    let release!: () => void;
    vi.spyOn(h.s, "refreshGuestRooms").mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const web = h.slash("alice");
    await Promise.resolve();
    expect(await h.ask(h.device()), "its /web is in flight (no code yet, so no minute yet)").toMatchObject({ kind: "limited" });
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    release(); await web;
  });
  it("a revoke while its DM is on its way withdraws that code", async () => {
    const h = rig();
    let release!: () => void;
    h.adapter.sendDirect.mockImplementationOnce(() => new Promise((r) => { release = () => r({ chatId: "DM", messageId: "dm" }); }));
    const asking = h.ask(h.device());
    await vi.waitFor(() => expect(release).toBeDefined());
    const code = codeOf(h.adapter.sendDirect.mock.calls[0]![1]);
    await h.slash("admin", "revoke");
    release();
    expect(await asking).toEqual({ kind: "refused" });
    expect(h.s.webGuestLoginCodes.match(code, tokenEpoch(TOKEN))).toBeNull();
    expect(h.adapter.sendDirect, "and no code-only follow-up after the revoke").toHaveBeenCalledTimes(1);
  });
  it("forgotten: by the guest's own /web revoke (theirs only), by guest sign-in turned off (every guest's)", async () => {
    const h = rig();
    const alice = h.device(), bob = h.device("bob");
    const admin = h.s.returningDevices.remember({ adapterId: "owner", userId: "admin", chatId: "G", threadId: "T0" }, { surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN), webToken: TOKEN });
    await h.slash("alice", "revoke");
    const known = (d: any) => h.s.returningDevices.size > 0 && [...h.s.returningDevices.byHash.values()].some((x: any) => x.idHash === d.idHash);
    expect([known(alice), known(bob)]).toEqual([false, true]);
    h.fm.fleetConfig!.web = { guests: { enabled: false } } as never;
    h.s.enforceGuestSwitch();
    expect(known(bob)).toBe(false);
    expect(h.s.returningDevices.verify(admin, TOKEN, tokenEpoch(TOKEN)), "an admin's device stays").not.toBeNull();
  });
});
