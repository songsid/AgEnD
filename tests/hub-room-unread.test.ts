/**
 * Hub rooms unread helper (hub-rooms-ux.md §12). Driven by the seam-1 fixture's live events
 * (web-claude PR #3848 @ fc757b8dd: message.added, answerLater() message.updated, invitation.changed).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";
import { counts, readWhen, shouldNotify, tabTitle } from "/ui/js/hub-room-unread.js";

const SRC = readFileSync("src/ui/hub-room-unread.js", "utf8");
const CSRF = { "x-agend-hub-csrf": "fixture-csrf" };
const ZERO = { unread: 0, mentioned: false, invitation: false, id: null };

type Live = { type: string } & Record<string, unknown>;
function listen(fx: ReturnType<typeof createHubRoomsFixture>) {
  const got: Live[] = [];
  const es = new fx.EventSource("/hub/v1/rooms/events");
  for (const type of ["message.added", "message.updated", "invitation.changed", "unread.changed", "presence.changed"]) {
    es.addEventListener(type, (e: { data: string }) => got.push({ type, ...JSON.parse(e.data) }));
  }
  return { got, close: () => es.close() };
}

function notifyEnv(over: { permission?: string; ua?: string; secure?: boolean; noApi?: boolean } = {}) {
  class Notification { static permission = over.permission ?? "granted"; }
  return {
    Notification: over.noApi ? undefined : Notification,
    navigator: { userAgent: over.ua ?? "Mozilla/5.0 (X11; Linux x86_64) Chrome/140" },
    isSecureContext: over.secure ?? true,
  };
}

function notifyOn() {
  const map = new Map<string, string>([["agend_needs_notify", "1"]]);
  vi.stubGlobal("localStorage", { getItem: (k: string) => map.get(k) ?? null, setItem: () => {}, removeItem: () => {} });
  return notifyEnv();
}

afterEach(() => vi.unstubAllGlobals());

describe("tabTitle / readWhen", () => {
  it('prefixes "(3) base" and restores base at 0', () => {
    expect(tabTitle("AgEnD Hub", 3)).toBe("(3) AgEnD Hub");
    expect(tabTitle("研一主管週會", 1)).toBe("(1) 研一主管週會");
    expect(tabTitle("AgEnD Hub", 0)).toBe("AgEnD Hub");
    expect(tabTitle("AgEnD Hub", -1)).toBe("AgEnD Hub");
  });
  it("marks read only when the room is open and scrolled to the bottom", () => {
    expect(readWhen(true, true)).toBe(true);
    expect(readWhen(false, true)).toBe(false);
    expect(readWhen(true, false)).toBe(false);
    expect(readWhen(false, false)).toBe(false);
  });
});

describe("counts: the fixture's live events (#3848)", () => {
  it("counts another person's message.added, not mine and not a system row", () => {
    const fx = createHubRoomsFixture();
    const { got, close } = listen(fx);
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen" && m.text.includes("這週的進度"))!;
    const mine = weekly.messages.find((m) => m.author.id === FIXTURE_ME.id && m.text.startsWith("好，我請"))!;
    const system = weekly.messages.find((m) => m.author.kind === "system")!;
    fx.emit("message.added", { roomId: weekly.id, message: chen });
    fx.emit("message.added", { roomId: weekly.id, message: mine });
    fx.emit("message.added", { roomId: weekly.id, message: system });
    fx.handle({ method: "POST", path: "/hub/v1/rooms/room-weekly/messages", headers: CSRF, body: { text: "我自己說的", idempotencyKey: "own-1" } });
    close();
    const added = got.filter((e) => e.type === "message.added");
    expect(counts(added[0]!, fx.me)).toEqual({ unread: 1, mentioned: false, invitation: false, id: chen.id });
    expect(counts(added[1]!, fx.me)).toEqual(ZERO);
    expect(counts(added[2]!, fx.me)).toEqual(ZERO);
    expect(counts(added[3]!, fx.me)).toEqual(ZERO);
  });

  it("marks mentioned when the row @s me", () => {
    const fx = createHubRoomsFixture();
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen")!;
    expect(counts({ type: "message.added", roomId: weekly.id, message: { ...chen, mentions: [FIXTURE_ME.id] } }, fx.me))
      .toEqual({ unread: 1, mentioned: true, invitation: false, id: chen.id });
  });

  it("counts answerLater() message.updated (an agent I @-ed answers) and skips the empty queued row", () => {
    const fx = createHubRoomsFixture();
    const { got, close } = listen(fx);
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const queued = weekly.messages.find((m) => m.stage === "queued" && !m.text)!;
    expect(counts({ type: "message.updated", roomId: weekly.id, message: queued }, fx.me)).toEqual(ZERO);
    const pending = fx.answerLater();
    close();
    const updated = got.find((e) => e.type === "message.updated")!;
    expect(pending && pending.stage).toBe("answered");
    expect(updated.parent).toMatchObject({ id: pending!.answerTo });
    expect(counts(updated, fx.me)).toEqual({ unread: 1, mentioned: false, invitation: false, id: pending!.id });
    expect(counts({ type: "message.updated", roomId: weekly.id, message: { ...pending, stage: "answered" } }, fx.me).id)
      .toBe(counts(updated, fx.me).id);
  });

  it("invitation.changed {} (accept/decline) is not a new invitation; a payload with invitation is", () => {
    const fx = createHubRoomsFixture();
    const { got, close } = listen(fx);
    const waiting = fx.invitations[0]!;
    fx.handle({ method: "POST", path: `/hub/v1/invitations/${waiting.id}/accept`, headers: CSRF, body: {} });
    fx.emit("invitation.changed", { invitation: { id: "inv-new", room: { id: "room-other", name: "產品規劃" } } });
    close();
    const changed = got.filter((e) => e.type === "invitation.changed");
    expect(changed[0]).toEqual({ type: "invitation.changed" });
    expect(counts(changed[0]!, fx.me)).toEqual(ZERO);
    expect(counts(changed[1]!, fx.me)).toEqual({ unread: 1, mentioned: false, invitation: true, id: "inv-new" });
  });
});

describe("shouldNotify reuses Fleet notifyOn and follows counts()", () => {
  it("imports notifyOn from app-needs.js and does not copy the rule", () => {
    expect([...SRC.matchAll(/^import .*$/gm)].map((m) => m[0])).toEqual(['import { notifyOn } from "/assets/app-needs.js";']);
    expect(SRC).not.toContain("agend_needs_notify");
    expect(SRC).not.toContain("notifySupport");
  });

  it("notifies another person's message when unfocused; own, system, and {} invitation stay silent", () => {
    const fx = createHubRoomsFixture();
    const env = notifyOn();
    const weekly = fx.rooms.find((r) => r.id === "room-weekly")!;
    const chen = weekly.messages.find((m) => m.author.id === "person-chen" && m.text.includes("這週的進度"))!;
    const mine = weekly.messages.find((m) => m.author.id === FIXTURE_ME.id && m.text.startsWith("好，我請"))!;
    const system = weekly.messages.find((m) => m.author.kind === "system")!;
    const other = { type: "message.added", roomId: weekly.id, message: chen };
    expect(shouldNotify(other, fx.me, false, env)).toBe(true);
    expect(shouldNotify(other, fx.me, true, env)).toBe(false);
    expect(shouldNotify({ type: "message.added", roomId: weekly.id, message: mine }, fx.me, false, env)).toBe(false);
    expect(shouldNotify({ type: "message.added", roomId: weekly.id, message: system }, fx.me, false, env)).toBe(false);
    expect(shouldNotify({ type: "invitation.changed" }, fx.me, false, env)).toBe(false);
    expect(shouldNotify({ type: "presence.changed" }, fx.me, false, env)).toBe(false);
    expect(shouldNotify(other, fx.me, false, notifyEnv({ permission: "denied" }))).toBe(false);
    expect(shouldNotify(other, fx.me, false, notifyEnv({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148" }))).toBe(false);
  });
});
