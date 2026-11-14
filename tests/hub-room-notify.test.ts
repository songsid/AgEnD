/**
 * Hub rooms desktop notifier (hub-rooms-ux.md §12: 和 Fleet 聊天相同的桌面通知（要先允許）).
 * Pure gate: hub-room-unread.js shouldNotify; opt-in rule: app-needs.js notifyOn — both imported, never copied.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";
import { notifyKind, startHubRoomNotifier } from "/ui/js/hub-room-notify.js";

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
  it("pings an @ to me, an agent answer and a new invitation — never plain chatter", () => {
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
    expect(notifyKind({ type: "message.updated", roomId: weekly.id, message: { ...chen, stage: "answered" } }, fx.me)).toBe("answer");
    expect(notifyKind({ type: "message.updated", roomId: weekly.id, message: { ...chen, stage: "consumed" } }, fx.me)).toBeNull();
    expect(notifyKind({ type: "invitation.changed", invitation: { id: "inv-new", room: { id: "room-x", name: "產品規劃" } } }, fx.me)).toBe("invitation");
    expect(notifyKind({ type: "invitation.changed" }, fx.me)).toBeNull();
    expect(notifyKind({ type: "presence.changed" }, fx.me)).toBeNull();
  });
});

describe("startHubRoomNotifier", () => {
  const fx = createHubRoomsFixture();
  function started(over: { permission?: string; hidden?: boolean; me?: { id: string } | null } = {}) {
    const env = optedEnv({ permission: over.permission });
    const client = fakeClient();
    const open = vi.fn();
    const starter = startHubRoomNotifier as (...args: Array<Record<string, unknown>>) => () => void;
    const stop = starter({
      client, me: over.me === undefined ? fx.me : over.me,
      roomName: (id: unknown) => (id ? "研一主管週會" : ""),
      open, env, doc: { hidden: over.hidden ?? true },
    });
    return { env, client, open, stop };
  }

  it("pings once per row for a mention, an answer and an invitation; plain rows stay silent", () => {
    const fx = createHubRoomsFixture();
    const { env, client, stop } = started();
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    const emit = (type: string, data: Record<string, unknown>) => (client.handlers[type] as (d: unknown) => void)(data);
    emit("message.added", { roomId: weekly.id, message: { ...chen, mentions: [fx.me.id] } });
    emit("message.updated", { roomId: weekly.id, message: { ...chen, stage: "answered" } });
    emit("invitation.changed", { invitation: { id: "inv-new", room: { id: "room-x", name: "產品規劃" } } });
    emit("message.added", { roomId: weekly.id, message: chen });
    expect(env.seen.map((n) => n.title)).toEqual(["研一主管週會", "研一主管週會", "AgEnD Hub"]);
    expect(env.seen[0]!.opts.body).toContain("陳主任");
    expect(env.seen[0]!.opts.body).toContain("研一主管週會");
    expect(env.seen[2]!.opts.body).toContain("產品規劃");
    // The same rows again: no second ping (tag dedupe).
    emit("message.added", { roomId: weekly.id, message: { ...chen, mentions: [fx.me.id] } });
    emit("message.updated", { roomId: weekly.id, message: { ...chen, stage: "answered" } });
    expect(env.seen).toHaveLength(3);
    stop();
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
      client, me: () => me, setMe: (m: unknown) => { me = (m as { id: string }) ?? null; },
      resolveMe: async () => { resolves += 1; return resolves === 1 ? null : { id: fx.me.id }; },
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
