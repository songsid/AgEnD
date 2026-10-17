/**
 * #1920 phase 2 (step 3, §3.2): a guest's ClassicBot group or guild room is in scope only while its membership is
 * verified — read in the background (now, ten minutes after each answer, a minute after a failed read, and when the
 * guest's stream connects), kept in memory, and only read by a request. Unknown, failed or stale (15 min) hides it.
 * - A scope that is empty only because a room is not read yet does not end the session (503 guest_scope_pending); a
 *   "not a member" answer, or no answer for the whole stale window, does (401 guest_scope_empty) — fail closed.
 * - Telegram groups ask getChatMember (isGroupMember); Discord rooms ask View Channel (canViewChannel). A Telegram
 *   private room is never a membership question; a room on another connection is never this guest's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-1920r-home-"));
process.env.AGEND_HOME = home;                         // before the fleet's modules load (pino's daemon.log)
const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { tokenEpoch } = await import("../src/web-session.js");
const { GuestRoomMembership, guestGroupRooms, GUEST_ROOM_STALE_MS, GUEST_ROOM_RECHECK_MS } = await import("../src/web-guest-rooms.js");

const ALICE = { adapterId: "dc", userId: "111111111111111111" };
const DC_ROOM = "222222222222222222", TG_GROUP = "-1001234567890", TG_PRIVATE = "5550001";
const room = (channelId: string, adapterId = "dc", instanceName = `classic-${channelId.slice(-4)}`) => ({ channelId, adapterId, instanceName, name: "r" }) as any;

describe("the membership answers", () => {
  const MIN = 60_000;
  const setup = (answer: () => Promise<boolean> | undefined) => {
    let now = 1_000_000;
    const read = vi.fn((_room: unknown, _user: string) => answer());
    const m = new GuestRoomMembership({ now: () => now, read, deadlineMs: 50 });
    return { m, read, tick: (ms: number) => { now += ms; } };
  };
  const R = guestGroupRooms([room(DC_ROOM)], ALICE)[0]!;

  it("guestGroupRooms: Telegram groups and Discord channels on the guest's own connection; never a private room", () => {
    const rooms = [room(DC_ROOM), room(TG_GROUP, "dc"), room(TG_PRIVATE, "dc"), room("333333333333333333", "tg2"), room("not-an-id")];
    expect(guestGroupRooms(rooms, ALICE).map((r) => [r.channelId, r.kind])).toEqual([[DC_ROOM, "discord"], [TG_GROUP, "telegram"]]);
  });
  it("shown only on a member answer at most 15 minutes old; asking is the refresh's, never the check's", async () => {
    const { m, read, tick } = setup(async () => true);
    expect(m.verified(R, ALICE.userId)).toBe(false);
    expect(m.pending(R, ALICE.userId), "not read yet: pending").toBe(true);
    expect(read).not.toHaveBeenCalled();
    await m.refresh(ALICE, [R]);
    expect(read).toHaveBeenCalledTimes(1);
    expect([m.verified(R, ALICE.userId), m.pending(R, ALICE.userId)]).toEqual([true, false]);
    tick(GUEST_ROOM_STALE_MS);
    expect(m.verified(R, ALICE.userId), "15 minutes: still").toBe(true);
    tick(1);
    expect([m.verified(R, ALICE.userId), m.pending(R, ALICE.userId)], "stale: hidden, and settled").toEqual([false, false]);
  });
  it("a 'not a member' answer settles it: hidden, not pending", async () => {
    const { m } = setup(async () => false);
    await m.refresh(ALICE, [R]);
    expect([m.verified(R, ALICE.userId), m.pending(R, ALICE.userId)]).toEqual([false, false]);
  });
  it("no answer (a rejection, a timeout, an adapter that cannot tell, a non-boolean): hidden; pending for the stale window only", async () => {
    for (const answer of [() => Promise.reject(new Error("429")), () => new Promise<boolean>(() => {}), () => undefined, () => Promise.resolve("yes" as any)]) {
      const { m, tick } = setup(answer);
      await m.refresh(ALICE, [R]);
      expect([m.verified(R, ALICE.userId), m.pending(R, ALICE.userId)]).toEqual([false, true]);
      tick(GUEST_ROOM_STALE_MS - 1);
      expect(m.pending(R, ALICE.userId)).toBe(true);
      tick(1);
      expect(m.pending(R, ALICE.userId), "fail closed once the window is over").toBe(false);
    }
  });
  it("a failed read after a member answer keeps that answer until it is stale", async () => {
    let ok = true;
    const { m, tick } = setup(() => (ok ? Promise.resolve(true) : Promise.reject(new Error("down"))));
    await m.refresh(ALICE, [R]);
    ok = false; tick(GUEST_ROOM_RECHECK_MS);
    await m.refresh(ALICE, [R]);
    expect(m.verified(R, ALICE.userId)).toBe(true);
    tick(GUEST_ROOM_STALE_MS - GUEST_ROOM_RECHECK_MS + 1);
    expect(m.verified(R, ALICE.userId)).toBe(false);
  });
  it("due: ten minutes after an answer; force: a minute after any read; one read shared", async () => {
    const { m, read, tick } = setup(() => Promise.resolve(true));
    await m.refresh(ALICE, [R]);
    tick(GUEST_ROOM_RECHECK_MS - 1); await m.refresh(ALICE, [R]);
    expect(read).toHaveBeenCalledTimes(1);
    tick(1); await m.refresh(ALICE, [R]);
    expect(read).toHaveBeenCalledTimes(2);
    await m.refresh(ALICE, [R], { mode: "force" });
    expect(read, "force waits a minute after the last read").toHaveBeenCalledTimes(2);
    tick(MIN - 1); await m.refresh(ALICE, [R], { mode: "force" });
    expect(read).toHaveBeenCalledTimes(2);
    tick(1); await m.refresh(ALICE, [R], { mode: "force" });
    expect(read).toHaveBeenCalledTimes(3);
    tick(GUEST_ROOM_RECHECK_MS);
    await Promise.all([m.refresh(ALICE, [R]), m.refresh(ALICE, [R]), m.refresh(ALICE, [R], { mode: "triggered" }), m.refresh(ALICE, [R], { mode: "force" })]);
    expect(read, "concurrent refreshes of every kind share one read").toHaveBeenCalledTimes(4);
  });
  it("leader's guard: failed reads back off 1, 2, 4, 8 … capped at 10 minutes, whoever asks; said once until an answer", async () => {
    let fail = true;
    let now = 0;
    const read = vi.fn(() => (fail ? Promise.reject(new Error("bot lacks permission")) : Promise.resolve(true)));
    const said: string[] = [];
    const m = new GuestRoomMembership({ now: () => now, read, deadlineMs: 50,
      onPersistentFailure: (room, failures) => said.push(`fail ${room.instance} ${failures}`), onRecovered: (room) => said.push(`ok ${room.instance}`) });
    const at: number[] = [];
    read.mockImplementation(() => { at.push(now / MIN); return fail ? Promise.reject(new Error("x")) : Promise.resolve(true); });
    for (now = 0; now <= 60 * MIN; now += 15_000) {
      // The tick, a pending guest's requests and a reconnecting stream, all every 15 s: none beats the backoff.
      await m.refresh(ALICE, [R]); await m.refresh(ALICE, [R], { mode: "triggered" }); await m.refresh(ALICE, [R], { mode: "force" });
    }
    expect(at).toEqual([0, 1, 3, 7, 15, 25, 35, 45, 55]);
    expect(said, "the persistent failure is said once").toEqual([`fail ${R.instance} 3`]);
    fail = false; now += 10 * MIN; await m.refresh(ALICE, [R]);
    expect(said.at(-1)).toBe(`ok ${R.instance}`);
    expect(m.verified(R, ALICE.userId)).toBe(true);
    // After an answer the count starts over: the next failures back off from a minute again, and are said again.
    fail = true; at.length = 0;
    for (const start = now + GUEST_ROOM_RECHECK_MS; now <= start + 8 * MIN; now += 15_000) await m.refresh(ALICE, [R]);
    expect(at.map((t) => t - at[0]!)).toEqual([0, 1, 3, 7]);
    expect(said.filter((x) => x.startsWith("fail"))).toHaveLength(2);
  });
  it("leader's guard: a pending guest's requests start at most one read per room in 30 s, whatever the volume", async () => {
    let now = 0;
    const read = vi.fn(() => Promise.resolve(true));
    // A short recheck, so only the 30 s floor stands between a request and the platform.
    const m = new GuestRoomMembership({ now: () => now, read, deadlineMs: 50, recheckMs: 5_000 });
    await Promise.all(Array.from({ length: 50 }, () => m.refresh(ALICE, [R], { mode: "triggered" })));
    expect(read, "single-flight").toHaveBeenCalledTimes(1);
    for (now = 1_000; now < 30_000; now += 1_000) await m.refresh(ALICE, [R], { mode: "triggered" });
    expect(read).toHaveBeenCalledTimes(1);
    now = 30_000; await m.refresh(ALICE, [R], { mode: "triggered" });
    expect(read).toHaveBeenCalledTimes(2);
    now = 36_000; await m.refresh(ALICE, [R]);
    expect(read, "the background pass keeps its own due time").toHaveBeenCalledTimes(3);
  });
});

interface Raw { status: number; body: string; headers: Record<string, unknown> }
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
    });
    r.on("error", reject); r.end();
  });
}
let fm: any, port = 0, dir: string, clock = 5_000_000;
const cookie = (sid: string) => ({ cookie: `${WEB_SESSION_COOKIE}=${sid}` });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-1920r-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
afterEach(() => { vi.restoreAllMocks(); fm.webSessions.revokeAll((r: any) => r.tier === "guest"); delete fm.fleetConfig.web; fm.guestRoomMembership = null; fm.classicChannels = null; fm.worlds.delete("dc"); });

describe("live: a guest whose only scope is a ClassicBot room", () => {
  const live = (rooms: any[], adapter: Record<string, unknown>) => {
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    fm.fleetConfig.web = { guests: { enabled: true } };
    fm.classicChannels = { getAll: () => rooms, getChannelIdByInstance: () => undefined };
    fm.worlds.set("dc", { adapter, accessManager: { isAllowed: () => false, getMode: () => "allowlist" } });
    return fm.webSessions.create({ tier: "guest", surface: "local", label: "guest", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner: ALICE }).sessionId as string;
  };
  const guests = () => fm.webSessions.list(undefined, (r: any) => r.tier === "guest").length;
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("not read yet: 503 pending (the session stays), never waiting on the platform; a member: in scope", async () => {
    let answer!: (v: boolean) => void;
    const canViewChannel = vi.fn(() => new Promise<boolean>((r) => { answer = r; }));
    const sid = live([room(DC_ROOM, "dc", "classic-room")], { canViewChannel });
    const first = await raw(port, "/ui/prefs", cookie(sid));
    expect([first.status, first.body, first.headers["retry-after"]]).toEqual([503, JSON.stringify({ error: "guest_scope_pending" }), "5"]);
    expect(canViewChannel, "the read started in the background, not awaited").toHaveBeenCalledWith(DC_ROOM, ALICE.userId);
    expect(guests()).toBe(1);
    answer(true); await settle();
    expect((await raw(port, "/ui/prefs", cookie(sid))).status).toBe(200);
    expect([...fm.guestScope(ALICE)]).toEqual(["classic-room"]);
    expect(canViewChannel, "a request reads the answer, it never asks").toHaveBeenCalledTimes(1);
  });
  it("left the room: out at the next read, and the emptied scope ends the session", async () => {
    let member = true;
    const canViewChannel = vi.fn(async () => member);
    const sid = live([room(DC_ROOM, "dc", "classic-room")], { canViewChannel });
    await fm.refreshAllGuestRooms();
    expect((await raw(port, "/ui/prefs", cookie(sid))).status).toBe(200);
    member = false; clock += GUEST_ROOM_RECHECK_MS;
    expect((await raw(port, "/ui/prefs", cookie(sid))).status, "until the next read, the answer stands").toBe(200);
    await fm.refreshAllGuestRooms();
    expect(await raw(port, "/ui/prefs", cookie(sid))).toMatchObject({ status: 401, body: JSON.stringify({ error: "guest_scope_empty" }) });
    expect(guests()).toBe(0);
  });
  it("no answer for the whole stale window: fail closed — the session ends", async () => {
    const canViewChannel = vi.fn(() => Promise.reject(new Error("Discord is down")));
    const sid = live([room(DC_ROOM, "dc", "classic-room")], { canViewChannel });
    const warn = vi.spyOn(fm.logger, "warn");
    await fm.refreshAllGuestRooms();
    expect((await raw(port, "/ui/prefs", cookie(sid))).status).toBe(503);
    // Backing off (1, then 2 minutes): the third failure is persistent — said once, without the account's id.
    clock += 60_000; await fm.refreshAllGuestRooms();
    clock += 120_000; await fm.refreshAllGuestRooms(); await fm.refreshAllGuestRooms();
    const said = warn.mock.calls.filter((c) => String(c[1]).includes("keeps failing"));
    expect(said).toHaveLength(1);
    expect(said[0]![0]).toEqual({ adapterId: "dc", instance: "classic-room", failures: 3 });
    expect(canViewChannel).toHaveBeenCalledTimes(3);
    clock += GUEST_ROOM_STALE_MS - 180_000 - 1;
    expect((await raw(port, "/ui/prefs", cookie(sid))).status).toBe(503);
    clock += 1;
    expect((await raw(port, "/ui/prefs", cookie(sid))).status).toBe(401);
    expect(guests()).toBe(0);
  });
  it("Telegram groups ask getChatMember; a private room and another connection's room are never asked", async () => {
    const isGroupMember = vi.fn(async () => true), canViewChannel = vi.fn(async () => true);
    live([room(TG_GROUP, "dc", "classic-tg"), room(TG_PRIVATE, "dc", "classic-dm"), room("333333333333333333", "other", "classic-other")], { isGroupMember, canViewChannel });
    await fm.refreshAllGuestRooms();
    expect(isGroupMember.mock.calls).toEqual([[TG_GROUP, ALICE.userId]]);
    expect(canViewChannel).not.toHaveBeenCalled();
    expect([...fm.guestScope(ALICE)]).toEqual(["classic-tg"]);
  });
  it("the background pass reads each account with a live guest session once (not an admin's)", async () => {
    const canViewChannel = vi.fn(async () => true);
    live([room(DC_ROOM, "dc", "classic-room")], { canViewChannel });
    fm.webSessions.create({ tier: "guest", surface: "local", label: "second device", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner: ALICE });
    fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!) });
    // A session not yet confirmed (pending) is no one's to read for.
    fm.webSessions.create({ tier: "guest", surface: "local", label: "unconfirmed", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), pending: true, owner: { adapterId: "dc", userId: "444444444444444444" } });
    expect(fm.webSessions.guestOwners()).toEqual([ALICE]);
    await fm.refreshAllGuestRooms();
    expect(canViewChannel).toHaveBeenCalledTimes(1);
  });
  it("narrowing still only takes away; guest sign-in off reads nothing", async () => {
    const canViewChannel = vi.fn(async () => true);
    live([room(DC_ROOM, "dc", "classic-room")], { canViewChannel });
    await fm.refreshAllGuestRooms();
    fm.fleetConfig.web.guests.narrow = { [`${ALICE.adapterId}:${ALICE.userId}`]: ["a"] };
    expect(fm.guestScope(ALICE).size).toBe(0);
    fm.fleetConfig.web.guests = { enabled: false };
    canViewChannel.mockClear(); clock += GUEST_ROOM_RECHECK_MS;
    await fm.refreshAllGuestRooms();
    expect(canViewChannel).not.toHaveBeenCalled();
  });
  it("its stream connecting reads its rooms again (forced, at most once a minute)", async () => {
    const canViewChannel = vi.fn(async () => true);
    const sid = live([room(DC_ROOM, "dc", "classic-room")], { canViewChannel });
    await fm.refreshAllGuestRooms();
    clock += 60_000;
    await new Promise<void>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, method: "GET", path: "/ui/events", headers: { host: `127.0.0.1:${port}`, ...cookie(sid), accept: "text/event-stream" } }, (res) => {
        expect(res.statusCode).toBe(200);
        res.once("data", () => { r.destroy(); resolve(); });
      });
      r.on("error", (e) => (String(e).includes("socket hang up") ? resolve() : reject(e))); r.end();
    });
    await settle();
    expect(canViewChannel).toHaveBeenCalledTimes(2);
  });
});

describe("Discord: canViewChannel (a ClassicBot room in any guild)", async () => {
  const { DiscordAdapter } = await import("../src/channel/adapters/discord.js");
  const { ChannelType, PermissionFlagsBits } = await import("discord.js");
  const USER = "123456789012345678";
  function discord(opts: { channel?: unknown; fetchMember?: (arg: any) => Promise<unknown> }) {
    const a = new DiscordAdapter({ id: "discord", botToken: "t", accessManager: { canRead: () => true, canWrite: () => true } as any, inboxDir: join(home, "dc-inbox"), guildId: "999" } as any);
    const members = { fetch: vi.fn(opts.fetchMember ?? (async () => ({ id: USER }))) };
    const channels = { fetch: vi.fn(async () => opts.channel) };
    (a as any).readyClient = async () => ({ channels });
    return { a, members, channels };
  }
  // `allow`: the bits this member has here (a thread's are its parent's, as discord.js answers them).
  const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  const channelIn = (members: any, view: boolean, extra: Record<string, unknown> = {}, allow: bigint[] = READ) =>
    ({ type: ChannelType.GuildText, guild: { members }, permissionsFor: (m: any) => ({ has: (bit: bigint) => m?.id === USER && view && allow.includes(bit) }), ...extra });

  it("a member with View Channel: yes; without it: no; read from Discord (force)", async () => {
    for (const view of [true, false]) {
      const members = { fetch: vi.fn(async () => ({ id: USER })) };
      const { a, channels } = discord({ channel: channelIn(members, view) });
      expect(await a.canViewChannel(DC_ROOM, USER)).toBe(view);
      expect(channels.fetch).toHaveBeenCalledWith(DC_ROOM);
      expect(members.fetch).toHaveBeenCalledWith({ user: USER, force: true });
    }
  });
  it("not in that guild (10007 Unknown Member, 10013 Unknown User): a definite no; any other error rejects (no answer)", async () => {
    for (const code of [10007, 10013]) {
      const members = { fetch: vi.fn(async () => { throw Object.assign(new Error("Unknown"), { code }); }) };
      expect(await discord({ channel: channelIn(members, true) }).a.canViewChannel(DC_ROOM, USER)).toBe(false);
    }
    const members = { fetch: vi.fn(async () => { throw Object.assign(new Error("rate limited"), { code: 429 }); }) };
    await expect(discord({ channel: channelIn(members, true) }).a.canViewChannel(DC_ROOM, USER)).rejects.toThrow("rate limited");
  });
  it("#2092 review: View Channel without Read Message History is no — the web shows the room's history", async () => {
    const members = { fetch: vi.fn(async () => ({ id: USER })) };
    expect(await discord({ channel: channelIn(members, true, {}, [PermissionFlagsBits.ViewChannel]) }).a.canViewChannel(DC_ROOM, USER)).toBe(false);
    expect(await discord({ channel: channelIn(members, true, {}, [PermissionFlagsBits.ReadMessageHistory]) }).a.canViewChannel(DC_ROOM, USER), "nor the reverse").toBe(false);
  });
  it("#2092 review: a private thread needs the user in it (or Manage Threads), not only its parent's permissions", async () => {
    const guildMembers = { fetch: vi.fn(async () => ({ id: USER })) };
    const thread = (threadFetch: () => Promise<unknown>, allow?: bigint[]) => {
      const members = { fetch: vi.fn(threadFetch) };
      return { members, channel: channelIn(guildMembers, true, { type: ChannelType.PrivateThread, members }, allow) };
    };
    const inIt = thread(async () => ({ id: USER }));
    expect(await discord({ channel: inIt.channel }).a.canViewChannel(DC_ROOM, USER)).toBe(true);
    expect(inIt.members.fetch).toHaveBeenCalledWith({ member: USER, force: true });
    const notIn = thread(async () => { throw Object.assign(new Error("Unknown Member"), { code: 10007 }); });
    expect(await discord({ channel: notIn.channel }).a.canViewChannel(DC_ROOM, USER), "sees the parent, not in the thread").toBe(false);
    const failing = thread(async () => { throw Object.assign(new Error("Missing Access"), { code: 50001 }); });
    await expect(discord({ channel: failing.channel }).a.canViewChannel(DC_ROOM, USER), "no answer").rejects.toThrow("Missing Access");
    const manager = thread(async () => { throw Object.assign(new Error("Unknown Member"), { code: 10007 }); }, [...READ, PermissionFlagsBits.ManageThreads]);
    expect(await discord({ channel: manager.channel }).a.canViewChannel(DC_ROOM, USER), "Manage Threads sees every private thread").toBe(true);
    expect(manager.members.fetch).not.toHaveBeenCalled();
    const noParent = thread(async () => ({ id: USER }), [PermissionFlagsBits.ManageThreads]);
    expect(await discord({ channel: noParent.channel }).a.canViewChannel(DC_ROOM, USER), "in the thread, but cannot read the parent").toBe(false);
    // A public thread is its parent's to see.
    const pub = { fetch: vi.fn(async () => { throw new Error("never asked"); }) };
    expect(await discord({ channel: channelIn(guildMembers, true, { type: ChannelType.PublicThread, members: pub }) }).a.canViewChannel(DC_ROOM, USER)).toBe(true);
    expect(pub.fetch).not.toHaveBeenCalled();
  });
  it("not a guild channel, or malformed ids: no, and nothing asked for malformed ids", async () => {
    expect(await discord({ channel: { id: "dm" } }).a.canViewChannel(DC_ROOM, USER)).toBe(false);
    expect(await discord({ channel: null }).a.canViewChannel(DC_ROOM, USER)).toBe(false);
    const d = discord({ channel: channelIn({ fetch: vi.fn() }, true) });
    expect([await d.a.canViewChannel(DC_ROOM, "not-an-id"), await d.a.canViewChannel("x", USER)]).toEqual([false, false]);
    expect(d.channels.fetch).not.toHaveBeenCalled();
  });
});
