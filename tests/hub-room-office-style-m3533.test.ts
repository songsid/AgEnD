/**
 * M-3533 R1b (docs/design/hub-office-visit.md §2.1b, plan D): the studio for a large Hub room — the studio's canvas,
 * desks and spacing; a rest area as large as the work area, its seats a full name tag apart; help and nap a strip below.
 * Seat counts come from each style's layout, never typed. The Fleet's own style picker does not change.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { ROOM_OFFICE_STYLES } from "../src/hub/rooms/office.js";

let skin: any, pack: any, settings: any, thread: any, i18n: any;
beforeAll(async () => {
  const p = page(); skin = await import("/ui/js/fleet-office-skin.js"); pack = await import("/ui/js/fleet-office-pack.js");
  settings = await import("/ui/js/hub-room-settings.js"); thread = await import("/ui/js/hub-room-thread.js"); i18n = await import("/assets/app-i18n.js"); p.restore();
});

describe("Studio (large)", () => {
  it("keeps the studio's 12 desks and gives 30 rest seats, 9 help and 6 nap: 57 against the studio's 41", () => {
    expect(skin.styleSeats("studio")).toEqual({ total: 41, rest: 14 });
    expect(skin.styleSeats("studio-large")).toEqual({ total: 57, rest: 30 });
    const a = skin.STUDIO_LARGE_PACK.areas;
    expect([a.desks.seats.length, a.lounge.seats.length, a.alert.seats.length, a.nap.seats.length]).toEqual([12, 30, 9, 6]);
    expect(a.desks).toEqual(skin.STUDIO_PACK.areas.desks);
  });
  it("puts rest seats a full name tag apart and every seat in its area, on the same canvas", () => {
    const tag = skin.TAG_TEXT_W + 10;
    const lounge = skin.STUDIO_LARGE_PACK.areas.lounge.seats;
    for (const s of lounge) for (const o of lounge) if (s !== o && s.y === o.y) expect(Math.abs(s.x - o.x)).toBeGreaterThanOrEqual(tag);
    for (const area of Object.values(skin.STUDIO_LARGE_PACK.areas) as any[]) for (const s of area.seats) {
      const r = area.rect;
      expect([area.name, s.x >= r.x && s.x <= r.x + r.w && s.y >= r.y && s.y <= r.y + r.h]).toEqual([area.name, true]);
      expect(s.x <= pack.LOGICAL.w && s.y <= pack.LOGICAL.h).toBe(true);
    }
    // Every seat is reachable: the walk graph has an aisle waypoint under each row joined to the hall.
    const ids = new Set(skin.STUDIO_LARGE_PACK.waypoints.map((w: any) => w.id));
    for (const [x, y] of skin.STUDIO_LARGE_PACK.edges) expect(ids.has(x) && ids.has(y)).toBe(true);
  });
  it("is drawable everywhere but offered only to rooms; an unknown style falls back instead of failing", () => {
    expect(skin.SKINS.get("studio-large")?.id).toBe("studio-large");
    expect(skin.BUILT_IN_SKINS).not.toContain("studio-large");
    expect(skin.ROOM_STYLES).toEqual(["studio-large", "studio", "cozy", "guild", "school"]);
    // The Hub accepts exactly the styles the page offers.
    expect(skin.ROOM_STYLES).toEqual([...ROOM_OFFICE_STYLES]);
    expect(skin.skinFor("no-such-style")).toBeTruthy();
    for (const id of skin.ROOM_STYLES) expect([id, skin.styleSeats(id)?.total > 0 && skin.styleSeats(id)?.rest > 0]).toEqual([id, true]);
    expect(skin.styleSeats("pixel")).toBeNull();
  });
});

describe("Room settings → Room office → Style (§2.1b)", () => {
  const detail = (agents: number, style = "studio", assistant = false) => ({ room: { id: "room", name: "Room", kind: "group" }, me: { id: "m", role: "manager" },
    members: [...Array.from({ length: agents }, (_, i) => ({ kind: "agent", id: `e${i}`, name: `A${i}` })), ...(assistant ? [{ kind: "assistant", id: "assistant", name: "Hub assistant" }] : [])],
    settings: { allMention: true, historyForNew: "since-join", office: { enabled: true, style } } });
  const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
  it("lists the room styles with their seats from their layouts, saves once with Save style, and hints when the room does not fit", async () => {
    const p = page(); i18n.setLang("zh-TW", { store: false });
    try {
      const update = vi.fn(async () => ({ ok: true }));
      await p.mount(h(settings.RoomSettings, { client: { roomOfficeV1: true, updateRoom: update }, roomId: "room", detail: detail(30, "studio", true), assistant: false }));
      await until(() => p.root.querySelectorAll(".hub-room-office-styles input[type=radio]").length);
      const rows = [...p.root.querySelectorAll(".hub-room-office-styles label")].map((l: any) => l.textContent.trim());
      expect(rows).toEqual(skin.ROOM_STYLES.map((id: string) => `${i18n.t(`hubRoom.style_${id}`)} · ${skin.styleSeats(id).total} 個座位`));
      expect(rows.slice(0, 2)).toEqual(["工作室（大） · 57 個座位", "工作室 · 41 個座位"]);
      expect(p.root.querySelector(".hub-room-office-fit")?.textContent).toBe("這個房間有 30 個 Agent。工作室 的休息區有 14 個座位，換成較大的風格就能讓每個 Agent 都有位子。");
      const save = p.root.querySelector(".hub-room-office-style-save") as any;
      expect(save.disabled).toBe(true);
      // Clicking through the list saves nothing; Save style saves the last pick, once.
      const radio = (id: string) => [...p.root.querySelectorAll(".hub-room-office-styles input[type=radio]")].find((e: any) => e.value === id || e.getAttribute("value") === id);
      for (const id of ["cozy", "guild", "studio-large"]) { fire(radio(id), "change"); await settle(2); }
      expect(update).not.toHaveBeenCalled();
      expect(p.root.querySelector(".hub-room-office-fit")).toBeNull();
      fire(p.root.querySelector(".hub-room-office-style-save"), "click"); await settle(10);
      expect(update.mock.calls).toEqual([["room", { office: { style: "studio-large" } }]]);
      // A room that fits its style: no hint.
      await p.mount(h(settings.RoomSettings, { client: { roomOfficeV1: true, updateRoom: update }, roomId: "room", detail: detail(10), assistant: false }));
      await until(() => p.root.querySelectorAll(".hub-room-office-styles input[type=radio]").length); expect(p.root.querySelector(".hub-room-office-fit")).toBeNull();
      // Office off: no style list.
      const off = detail(30); off.settings.office.enabled = false;
      await p.mount(h(settings.RoomSettings, { client: { roomOfficeV1: true, updateRoom: update }, roomId: "room", detail: off, assistant: false })); await settle(20);
      expect(p.root.querySelector(".hub-room-office-styles")).toBeNull();
    } finally { await p.unmount(); p.restore(); }
  });
  it.each([["en", "Owner changed the room office's style to “Studio (large)”"], ["zh-TW", "Owner 把房間辦公室的風格換成「工作室（大）」"]])("the style line in the reader's words (%s)", (lang, line) => {
    i18n.setLang(lang, { store: false });
    expect(thread.systemText({ system: { kind: "office-style-changed", name: "Owner", style: "studio-large" }, text: "x" })).toBe(line);
    expect(thread.systemText({ system: { kind: "office-style-changed", name: "Owner", style: "future-style" }, text: "x" })).toContain("future-style");
  });
});
