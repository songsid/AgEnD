/**
 * Hub rooms desktop notifier (hub-rooms-ux.md §12: 和 Fleet 聊天相同的桌面通知（要先允許）).
 * Pure gate: hub-room-unread.js shouldNotify; opt-in rule: app-needs.js notifyOn — both imported, never copied.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";
import { clearHubMeId, noteHubMeId, notifyKind, rememberedMeId, startHubRoomNotifier } from "/ui/js/hub-room-notify.js";

const SRC = readFileSync("src/ui/hub-room-notify.js", "utf8");
const CSS = readFileSync("src/ui/shared/hub-chat.css", "utf8");

type Live = { type: string } & Record<string, unknown>;

function notifyEnv(over: { permission?: string; ua?: string; secure?: boolean; noApi?: boolean } = {}) {
  const seen: Array<{ title: string; opts: { body?: string; tag?: string }; closed: boolean; onclick: (() => void) | null }> = [];
  class Notification {
    static permission = over.permission ?? "granted";
    onclick: (() => void) | null = null;
    closed = false;
    constructor(public title: string, public opts: { body?: string; tag?: string }) { seen.push(this as unknown as (typeof seen)[number]); }
    close() { this.closed = true; }
  }
  return {
    seen,
    focus: vi.fn(),
    Notification: over.noApi ? undefined : Notification,
    navigator: { userAgent: over.ua ?? "Mozilla/5.0 (X11; Linux x86_64) Chrome/140" },
    isSecureContext: over.secure ?? true,
  };
}

function optedEnv(over: { permission?: string } = {}) {
  const map = new Map<string, string>([["agend_needs_notify", "1"]]);
  vi.stubGlobal("localStorage", { getItem: (k: string) => map.get(k) ?? null, setItem: () => {}, removeItem: () => {} });
  return notifyEnv(over);
}

function fakeClient() {
  const handlers: Record<string, (data: unknown) => void> = {};
  return {
    handlers,
    unsubscribed: 0,
    subscribeRooms(h: Record<string, (data: unknown) => void>) {
      Object.assign(handlers, h);
      return () => { this.unsubscribed += 1; };
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("notifyKind", () => {
  it("pings an @ to me, an answer to my question, a new invitation and any direct message — never group chatter", () => {
    const fx = createHubRoomsFixture();
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    const mine = weekly.messages.find((m) => m.author.id === fx.me.id)!;
    const system = weekly.messages.find((m) => m.author.kind === "system")!;
    const at = (m: unknown) => ({ type: "message.added", roomId: weekly.id, message: m });
    expect(notifyKind(at({ ...chen, mentions: [fx.me.id] }), fx.me)).toBe("mention");
    expect(notifyKind(at(chen), fx.me)).toBeNull();
    expect(notifyKind(at(mine), fx.me)).toBeNull();
    expect(notifyKind(at(system), fx.me)).toBeNull();
    const answered = (over: object) => ({ type: "message.updated", roomId: weekly.id, message: { ...chen, stage: "answered", answerTo: "q-1", ...over } });
    expect(notifyKind(answered({ askedBy: fx.me.id }), fx.me)).toBe("answer");
    expect(notifyKind(answered({}), fx.me)).toBeNull();
    expect(notifyKind(answered({ askedBy: "person-other" }), fx.me)).toBeNull();
    expect(notifyKind({ type: "message.updated", roomId: weekly.id, message: { ...chen, stage: "consumed", answerTo: "q-1", askedBy: fx.me.id } }, fx.me)).toBeNull();
    expect(notifyKind({ type: "invitation.changed", invitation: { id: "inv-new", room: { id: "room-x", name: "產品規劃" } } }, fx.me)).toBe("invitation");
    expect(notifyKind({ type: "invitation.changed" }, fx.me)).toBeNull();
    expect(notifyKind({ type: "presence.changed" }, fx.me)).toBeNull();
    expect(notifyKind(at(chen), fx.me, { direct: true })).toBe("direct");
    expect(notifyKind(at(chen), fx.me, { direct: false })).toBeNull();
    expect(notifyKind(at(chen), fx.me)).toBeNull();
    expect(notifyKind(at(mine), fx.me, { direct: true })).toBeNull();
  });
});

describe("remembered person id, per room (Fable P2: a sign-out and sign-in as someone else resets it)", () => {
  it("keeps a noted id per room, ignores empty values, and forgets all on clear", () => {
    clearHubMeId();
    expect(rememberedMeId("room-a")).toBeNull();
    noteHubMeId("room-a", "person-wang");
    expect(rememberedMeId("room-a")).toBe("person-wang");
    expect(rememberedMeId("room-b")).toBeNull();
    noteHubMeId("room-a", "");
    noteHubMeId("", "person-wang");
    expect(rememberedMeId("room-a")).toBe("person-wang");
    noteHubMeId("room-b", "person-chen");
    expect(rememberedMeId("room-b")).toBe("person-chen");
    expect(rememberedMeId("room-a")).toBe("person-wang");
    // panel-hub.js setSession clears whenever the login changes (sign-out, or in as someone else);
    // each room's id is learned again from a room detail or the lazy resolve.
    clearHubMeId();
    expect(rememberedMeId("room-a")).toBeNull();
    expect(rememberedMeId("room-b")).toBeNull();
  });
});

describe("sign-out and sign-in as someone else (Fable P2 scenario)", () => {
  it("stops matching the previous id and matches the new one", () => {
    const fx = createHubRoomsFixture();
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    const wang = weekly.messages.find((m) => m.author.id === fx.me.id)!;
    const chenId = "person-chen";
    const env = optedEnv();
    const client = fakeClient();
    const starter = startHubRoomNotifier as (...args: Array<Record<string, unknown>>) => () => void;
    const stop = starter({
      client,
      me: (rid: unknown) => { const id = rememberedMeId(rid as string); return id ? { id } : null; },
      setMe: (rid: unknown, m: unknown) => noteHubMeId(rid as string, (m as { id: string })?.id),
      roomName: () => "研一主管週會", open: vi.fn(), env, doc: { hidden: true },
    });
    const emit = (data: Record<string, unknown>) => (client.handlers["message.added"] as (d: unknown) => void)(data);
    // A (person-wang) signed in: an @A mention pings.
    noteHubMeId(weekly.id, fx.me.id);
    emit({ roomId: weekly.id, message: { ...chen, mentions: [fx.me.id] } });
    expect(env.seen).toHaveLength(1);
    // Sign-out and in as B (person-chen): the same @A row no longer pings.
    clearHubMeId();
    noteHubMeId(weekly.id, chenId);
    emit({ roomId: weekly.id, message: { ...chen, mentions: [fx.me.id] } });
    expect(env.seen).toHaveLength(1);
    // B mentioned by someone else: pings again, with B no longer treated as A.
    emit({ roomId: weekly.id, message: { ...wang, mentions: [chenId] } });
    expect(env.seen).toHaveLength(2);
    expect(env.seen[1]!.opts.body).toContain("王經理");
    stop();
    clearHubMeId();
  });
});

describe("startHubRoomNotifier", () => {
  const fx = createHubRoomsFixture();
  function started(over: { permission?: string; hidden?: boolean; me?: { id: string } | null; direct?: boolean } = {}) {
    const env = optedEnv({ permission: over.permission });
    const client = fakeClient();
    const open = vi.fn();
    const starter = startHubRoomNotifier as (...args: Array<Record<string, unknown>>) => () => void;
    const stop = starter({
      client, me: over.me === undefined ? fx.me : over.me,
      roomName: (id: unknown) => (id ? "研一主管週會" : ""),
      roomKind: () => (over.direct ? "direct" : "group"),
      open, env, doc: { hidden: over.hidden ?? true },
    });
    return { env, client, open, stop };
  }

  it("pings once per row for a mention, my answer and an invitation; plain and others' answers stay silent", () => {
    const fx = createHubRoomsFixture();
    const { env, client, stop } = started();
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    const emit = (type: string, data: Record<string, unknown>) => (client.handlers[type] as (d: unknown) => void)(data);
    const answer = (over: object) => ({ ...chen, stage: "answered", answerTo: "q-1", ...over });
    emit("message.added", { roomId: weekly.id, message: { ...chen, mentions: [fx.me.id] } });
    emit("message.updated", { roomId: weekly.id, message: answer({ askedBy: fx.me.id }) });
    emit("message.updated", { roomId: weekly.id, message: answer({ askedBy: "person-other" }) });
    emit("message.updated", { roomId: weekly.id, message: answer({}) });
    emit("invitation.changed", { invitation: { id: "inv-new", room: { id: "room-x", name: "產品規劃" } } });
    emit("message.added", { roomId: weekly.id, message: chen });
    expect(env.seen.map((n) => n.title)).toEqual(["研一主管週會", "研一主管週會", "AgEnD Hub"]);
    expect(env.seen[0]!.opts.body).toContain("陳主任");
    expect(env.seen[0]!.opts.body).toContain("研一主管週會");
    expect(env.seen[2]!.opts.body).toContain("產品規劃");
    // The same rows again: no second ping (kind + row dedupe).
    emit("message.added", { roomId: weekly.id, message: { ...chen, mentions: [fx.me.id] } });
    emit("message.updated", { roomId: weekly.id, message: answer({ askedBy: fx.me.id }) });
    expect(env.seen).toHaveLength(3);
    stop();
  });

  it("pings any new direct-room message with the direct wording", () => {
    const fx = createHubRoomsFixture();
    const { env, client, stop } = started({ direct: true });
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    (client.handlers["message.added"] as (d: unknown) => void)({ roomId: "room-direct", message: chen });
    expect(env.seen).toHaveLength(1);
    expect(env.seen[0]!.title).toBe("研一主管週會");
    expect(env.seen[0]!.opts.body).toContain("陳主任");
    stop();
    const grouped = started();
    (grouped.client.handlers["message.added"] as (d: unknown) => void)({ roomId: weekly.id, message: chen });
    expect(grouped.env.seen).toHaveLength(0);
    grouped.stop();
  });

  it("matches each room against its own member id (Fable P2-3: ids are per room)", () => {
    // Two rooms, two different member ids for me — the fixture uses one id everywhere, so craft them here.
    const ids: Record<string, { id: string }> = { "room-a": { id: "member-a" }, "room-b": { id: "member-b" } };
    const env = optedEnv();
    const client = fakeClient();
    const open = vi.fn();
    const starter = startHubRoomNotifier as (...args: Array<Record<string, unknown>>) => () => void;
    const stop = starter({
      client, me: (rid: unknown) => ids[rid as string] ?? null, roomName: (id: unknown) => String(id),
      roomKind: () => "group", open, env, doc: { hidden: true },
    });
    const emit = (type: string, data: Record<string, unknown>) => (client.handlers[type] as (d: unknown) => void)(data);
    const chen = { id: "m1", roomId: "room-a", at: 1, author: { kind: "person", id: "person-chen", name: "陳主任" }, text: "hi @你", mentions: [] as string[] };
    // An @mention of room-a's me in room A pings; the identical row in room B (different me) stays silent.
    emit("message.added", { roomId: "room-a", message: { ...chen, mentions: ["member-a"] } });
    expect(env.seen).toHaveLength(1);
    emit("message.added", { roomId: "room-b", message: { ...chen, mentions: ["member-a"] } });
    expect(env.seen).toHaveLength(1);
    // An answer to my room-B question (askedBy is room B's member id) pings in room B only.
    const answer = { ...chen, stage: "answered", answerTo: "q-9", askedBy: "member-b" };
    emit("message.updated", { roomId: "room-b", message: answer });
    expect(env.seen).toHaveLength(2);
    emit("message.updated", { roomId: "room-a", message: answer });
    expect(env.seen).toHaveLength(2);
    // My own message from another device in a direct room does not ping: its author id is room A's me.
    const mine = { ...chen, author: { kind: "agent", id: "member-a", name: "我" } };
    stop();
    const directEnv = optedEnv();
    const directClient = fakeClient();
    const stopDirect = starter({
      client: directClient, me: (rid: unknown) => ids[rid as string] ?? null, roomName: (id: unknown) => String(id),
      roomKind: () => "direct", open: vi.fn(), env: directEnv, doc: { hidden: true },
    });
    (directClient.handlers["message.added"] as (d: unknown) => void)({ roomId: "room-a", message: mine });
    expect(directEnv.seen).toHaveLength(0);
    stopDirect();
  });

  it("stays silent when focused, opted out, or for my own rows; a click focuses and opens the room", () => {
    const fx = createHubRoomsFixture();
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    const mine = weekly.messages.find((m) => m.author.id === fx.me.id)!;
    const mention = { roomId: weekly.id, message: { ...chen, mentions: [fx.me.id] } };
    const focused = started({ hidden: false });
    (focused.client.handlers["message.added"] as (d: unknown) => void)(mention);
    expect(focused.env.seen).toHaveLength(0);
    focused.stop();
    const denied = started({ permission: "denied" });
    (denied.client.handlers["message.added"] as (d: unknown) => void)(mention);
    expect(denied.env.seen).toHaveLength(0);
    denied.stop();
    const s = started();
    (s.client.handlers["message.added"] as (d: unknown) => void)({ roomId: weekly.id, message: mine });
    expect(s.env.seen).toHaveLength(0);
    (s.client.handlers["message.added"] as (d: unknown) => void)(mention);
    expect(s.env.seen).toHaveLength(1);
    s.env.seen[0]!.onclick!();
    expect(s.env.focus).toHaveBeenCalledTimes(1);
    expect(s.open).toHaveBeenCalledWith(weekly.id);
    expect(s.env.seen[0]!.closed).toBe(true);
    s.stop();
  });

  it("without a known me, message rows are skipped but invitations still ping; stop unsubscribes", () => {
    const s = started({ me: null });
    const fx = createHubRoomsFixture();
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    (s.client.handlers["message.added"] as (d: unknown) => void)({ roomId: weekly.id, message: { ...chen, mentions: ["person-wang"] } });
    expect(s.env.seen).toHaveLength(0);
    (s.client.handlers["invitation.changed"] as (d: unknown) => void)({ invitation: { id: "inv-9", room: { id: "r", name: "新房間" } } });
    expect(s.env.seen).toHaveLength(1);
    s.stop();
    expect(s.client.unsubscribed).toBe(1);
  });

  it("learns me through resolveMe, retried on the next event while still unknown", async () => {
    const fx = createHubRoomsFixture();
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    let me: { id: string } | null = null;
    let resolves = 0;
    const env = optedEnv();
    const client = fakeClient();
    const starter = startHubRoomNotifier as (...args: Array<Record<string, unknown>>) => () => void;
    const stop = starter({
      client, me: () => me, setMe: (rid: unknown, m: unknown) => { me = (m as { id: string }) ?? null; },
      resolveMe: async (rid: unknown) => { resolves += 1; return resolves === 1 ? null : { id: fx.me.id }; },
      roomName: () => "研一主管週會", open: vi.fn(), env, doc: { hidden: true },
    });
    const mention = { roomId: weekly.id, message: { ...chen, mentions: [fx.me.id] } };
    (client.handlers["message.added"] as (d: unknown) => void)(mention);
    expect(env.seen).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    (client.handlers["message.added"] as (d: unknown) => void)(mention);
    expect(env.seen).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    (client.handlers["message.added"] as (d: unknown) => void)(mention);
    expect(env.seen).toHaveLength(1);
    expect(env.seen[0]!.opts.body).toContain("陳主任");
    stop();
  });

  it("drops a lazy resolve that lands after a restart or stop (Fable: no stale A id for B)", async () => {
    const fx = createHubRoomsFixture();
    let release = (v: { id: string } | null) => {};
    const gate = new Promise<{ id: string } | null>((r) => { release = r; });
    const env = optedEnv();
    const starter = startHubRoomNotifier as (...args: Array<Record<string, unknown>>) => () => void;
    const seen: unknown[] = [];
    const one = fakeClient(), two = fakeClient();
    starter({ client: one, me: () => null, setMe: (rid: unknown, m: unknown) => seen.push(m),
      resolveMe: () => gate, roomName: () => "", open: vi.fn(), env, doc: { hidden: true } });
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    // An event while me is unknown starts the lazy resolve on the first watcher.
    (one.handlers["message.added"] as (d: unknown) => void)({ roomId: weekly.id, message: chen });
    // A restart (sign-in change) replaces the watcher before the resolve lands.
    const stop = starter({ client: two, me: () => null, setMe: (rid: unknown, m: unknown) => seen.push(m),
      resolveMe: async () => null, roomName: () => "", open: vi.fn(), env, doc: { hidden: true } });
    release({ id: fx.me.id });
    await gate;
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
    stop();
  });

  it("pings the first event in a room once its id resolves, exactly once (Fable: lost first ping)", async () => {
    const fx = createHubRoomsFixture();
    const env = optedEnv();
    const client = fakeClient();
    const starter = startHubRoomNotifier as (...args: Array<Record<string, unknown>>) => () => void;
    const ids: Record<string, { id: string }> = {};
    const stop = starter({
      client, me: (rid: unknown) => ids[rid as string] ?? null,
      setMe: (rid: unknown, m: unknown) => { ids[rid as string] = m as { id: string }; },
      resolveMe: async (rid: unknown) => { await new Promise((r) => setTimeout(r, 0)); return { id: `member-${rid}` }; },
      roomName: (id: unknown) => String(id), open: vi.fn(), env, doc: { hidden: true },
    });
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    // No remembered id for room-new: an @mention there starts the resolve and stays silent for now.
    (client.handlers["message.added"] as (d: unknown) => void)({ roomId: "room-new", message: { ...chen, mentions: ["member-room-new"] } });
    expect(env.seen).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 10));
    // Once the resolve lands, the same event replays through the normal path: exactly one ping, no double.
    expect(env.seen).toHaveLength(1);
    expect(env.seen[0]!.opts.body).toContain("陳主任");
    stop();
  });

  it("a second start replaces the first", () => {
    const a = started();
    const b = started();
    expect(a.client.unsubscribed).toBe(1);
    expect(b.client.unsubscribed).toBe(0);
    b.stop();
  });
});

describe("module hygiene (precedent: hub-room-unread.test.ts)", () => {
  it("imports the Fleet rule and the counts gate instead of copying them", () => {
    const imports = [...SRC.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports).toContain('import { notifyOn, notifySupport, notifyStore, refreshNotify, setNotify } from "/assets/app-needs.js";');
    expect(imports).toContain('import { counts, shouldNotify } from "./hub-room-unread.js";');
    expect(SRC).not.toContain("agend_needs_notify");
    expect(SRC).toContain("new env.Notification(");
    expect(SRC).not.toMatch(/new Notification\(/);
  });

  it("hub-chat.css body text scales with the text-size setting (no fixed px)", () => {
    expect(CSS).not.toMatch(/font-size:\s*11\.5px/);
    expect(CSS).toMatch(/\.hub-room-side\s*\{[^}]*font-size:\s*var\(--fs-xs\)/);
  });

  it("the rooms header controls are full tap targets on a phone (ui-gate tap ratchet)", () => {
    expect(CSS).toMatch(/\.hub-head-tools\s*\{[^}]*display:\s*inline-flex/);
    expect(CSS).toMatch(/\.hub-head-tools \.hd-text, \.hub-head-tools \.hub-notify\s*\{[^}]*min-width:\s*var\(--tap\)[^}]*min-height:\s*var\(--tap\)/);
  });
});
