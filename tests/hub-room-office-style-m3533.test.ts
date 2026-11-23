/**
 * M-3533 R1b (docs/design/hub-office-visit.md §2.1b, plan D): the studio for a large Hub room — the studio's canvas,
 * desks and spacing; a rest area as large as the work area, its seats a full name tag apart; help and nap a strip below.
 * Seat counts come from each style's layout, never typed. The Fleet's own style picker does not change.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { page } from "./helpers/app-harness.js";

let skin: any, pack: any;
beforeAll(async () => { const p = page(); skin = await import("/ui/js/fleet-office-skin.js"); pack = await import("/ui/js/fleet-office-pack.js"); p.restore(); });

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
    expect(skin.skinFor("no-such-style")).toBeTruthy();
    for (const id of skin.ROOM_STYLES) expect([id, skin.styleSeats(id)?.total > 0 && skin.styleSeats(id)?.rest > 0]).toEqual([id, true]);
    expect(skin.styleSeats("pixel")).toBeNull();
  });
});
