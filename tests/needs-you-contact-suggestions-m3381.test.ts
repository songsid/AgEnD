/**
 * M-3381 (the user's beta.14 host, Telegram): after the upgrade, Needs you's live message read "等你處理 — 5" with one line
 * per existing ClassicBot room — "[room] — 建議將這個房間切換為受限模式 (148d)" — no word of what to do or where, one row per
 * room flooding the list, and the age counted from the room's creation. Now:
 * - the chat gets ONE line per world for its rooms' restricted-mode suggestions: how many rooms, where to act (/web → Needs
 *   you, or a room's Settings → Permissions), that nothing changes on its own; it counts once in the header;
 * - each room's age counts from when its suggestion was first raised (recorded by the store), in the chat and on the web;
 * - the web keeps its own per-room cards (switch / preview / later), unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { NeedsYouHub, type NeedsYouHubContext } from "../src/needs-you-hub.js";
import type { NeedsYouItem } from "../src/needs-you.js";
import { getLocale, setLocale, t } from "../src/locale.js";
import type { ContactPerson } from "../src/contact-auth-types.js";

const DAY = 86_400_000;
const admin: ContactPerson = { platform: "telegram", adapterId: "fake-bot", userId: "fake-admin", label: "Admin" };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

/** Five old ClassicBot rooms (136–156 days), not restricted; one restricted; one whose suggestion was dismissed. */
function manager() {
  const directory = mkdtempSync(join(tmpdir(), "m3381-"));
  const outbox = new DeliveryOutbox(join(directory, "outbox.db"));
  cleanups.push(() => { outbox.close(); rmSync(directory, { recursive: true, force: true }); });
  const old = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const rooms = [136, 140, 148, 150, 156].map((d, i) => ({ instanceName: `room-${i + 1}`, channelId: `c${i}`, adapterId: "fake-bot", createdAt: old(d) }));
  rooms.push({ instanceName: "room-strict", channelId: "c9", adapterId: "fake-bot", createdAt: old(100), restrictedMode: true } as any);
  rooms.push({ instanceName: "room-later", channelId: "c8", adapterId: "fake-bot", createdAt: old(120) });
  outbox.contactAuthorizations.dismissSuggestion("room-later");
  const m = Object.assign(Object.create(FleetManager.prototype), {
    dataDir: directory, deliveryOutbox: outbox, fleetConfig: { defaults: {}, instances: {} },
    classicChannels: { getAll: () => rooms, isAdmin: (id: string) => id === admin.userId },
    getAdapterForInstance: () => ({ type: "telegram", id: "fake-bot" }), getInstanceAdapterId: () => "fake-bot",
    contactAdminOf: () => true, adminListOf: () => [admin.userId],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }) as FleetManager & Record<string, any>;
  return { m, rooms };
}

describe("M-3381: the chat's restricted-mode suggestions", () => {
  it("one item per world for all its rooms (not one per room), with the count; dismissed and restricted rooms left out", () => {
    const { m } = manager();
    const items = (m as any).contactSuggestions() as NeedsYouItem[];
    const suggestions = items.filter(i => i.reason === "contact_restricted_suggestion");
    expect(suggestions.map(i => [i.id, i.instance, i.owner, i.contactSuggestionCount])).toEqual([["contact-suggest:rooms:fake-bot", "", "fake-bot", 5]]);
  });
  it("#4228 review: low-key — quiet (no new-item notification, no DM), explicitly", () => {
    const { m } = manager();
    const item = ((m as any).contactSuggestions() as NeedsYouItem[]).find(i => i.reason === "contact_restricted_suggestion")!;
    expect(item.quiet).toBe(true);
  });
  it("#4228 review: rooms raised at different times — the world's line is aged from the earliest", () => {
    const { m } = manager();
    const early = Date.now() - 3 * DAY, later = Date.now() - DAY;
    const db = (m.deliveryOutbox as any).db;
    db.prepare("INSERT INTO contact_auth_suggestion_raised VALUES (?,?)").run("room-4", later);
    db.prepare("INSERT INTO contact_auth_suggestion_raised VALUES (?,?)").run("room-2", early);
    const item = ((m as any).contactSuggestions() as NeedsYouItem[]).find(i => i.reason === "contact_restricted_suggestion")!;
    expect(item.since).toBe(early);
  });
  it("its age counts from when the suggestion was raised — not from the rooms' creation (136–156 days ago) — and stays put", () => {
    const { m } = manager();
    const before = Date.now();
    const first = ((m as any).contactSuggestions() as NeedsYouItem[]).find(i => i.reason === "contact_restricted_suggestion")!;
    expect(first.since).toBeGreaterThanOrEqual(before);
    expect(first.since).toBeLessThanOrEqual(Date.now());
    const again = ((m as any).contactSuggestions() as NeedsYouItem[]).find(i => i.reason === "contact_restricted_suggestion")!;
    expect(again.since).toBe(first.since);
  });
  it("the web keeps one card per room (its switch / preview / later), each aged from when it was raised", () => {
    const { m } = manager();
    const before = Date.now();
    const web = ((m as any).contactNeeds(admin) as NeedsYouItem[]).filter(i => i.reason === "contact_restricted_suggestion");
    expect(web.map(i => i.contactSuggestion?.instance)).toEqual(["room-1", "room-2", "room-3", "room-4", "room-5"]);
    for (const i of web) expect(i.since, i.instance).toBeGreaterThanOrEqual(before);
  });
});

/** The live message one Telegram world gets, rendered by the real hub with the real locale. */
async function liveText(lang: "en" | "zh-TW", items: NeedsYouItem[]) {
  const was = getLocale(); setLocale(lang); cleanups.push(() => setLocale(was));
  const dir = mkdtempSync(join(tmpdir(), "m3381-hub-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const posted: string[] = [];
  const tg = { type: "telegram", notifyAlert: vi.fn(async (_c: string, alert: { message: string }) => { posted.push(alert.message); return { messageId: "1", chatId: "-1001" }; }),
    editAlert: vi.fn(async (_c: string, _m: string, alert: { message: string }) => { posted.push(alert.message); }), deleteMessage: vi.fn(async () => {}) };
  const timers: Array<{ fn: () => void }> = [];
  const ctx = {
    dataDir: dir, now: () => Date.now(), mono: () => 0,
    setTimer: (fn: () => void) => { timers.push({ fn }); return timers.length; }, clearTimer: () => {},
    prompts: () => [], instances: () => [], deliveries: () => [], ownerOf: () => "fake-bot",
    contactSuggestions: () => items,
    worlds: () => [{ id: "fake-bot", place: { type: "telegram", groupId: "-1001" }, adapter: tg }],
    noticeTarget: () => ({ chatId: "-1001" }), instanceTopic: () => undefined, instanceName: (i: string) => i,
    isFleetAdmin: () => true, fleetAdmins: () => ["fake-admin"], emitSse: () => {}, acknowledge: () => false,
    settings: () => ({ liveMessage: true, dm: false }), stopping: () => false, t, log: () => {},
  } as unknown as NeedsYouHubContext;
  const hub = new NeedsYouHub(ctx);
  hub.start();
  for (let round = 0; round < 5 && !posted.length; round++) {
    for (const timer of timers.splice(0)) timer.fn();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  const text = posted.at(-1) ?? "";
  await hub.stop?.();                                                 // (its "Fleet stopped" edit comes after)
  return text;
}

describe("M-3381: the chat text (Telegram), en and zh-TW", () => {
  const group: NeedsYouItem = { id: "contact-suggest:rooms:fake-bot", type: "contact", reason: "contact_restricted_suggestion", instance: "",
    owner: "fake-bot", since: Date.now() - 5 * 60_000, detail: "", contactSuggestionCount: 5 } as NeedsYouItem;
  it("en: one line counted once — how many rooms, where to act, nothing automatic; no room-by-room rows", async () => {
    const text = await liveText("en", [group]);
    expect(text).toBe("📥 Needs you — 1\n• 5 existing ClassicBot room(s) can switch to restricted mode — to review: /web → Needs you, or a room's Settings → Permissions. Nothing changes on its own. (5m)");
  });
  it("zh-TW: the same, in Traditional Chinese", async () => {
    const text = await liveText("zh-TW", [group]);
    expect(text).toBe("📥 等你處理 — 1\n• 5 個既有 ClassicBot 房間可以切換為受限模式 — 查看方式：/web → 等你處理，或房間的設定 → 權限。不會自動切換。 (5m)");
  });
});
