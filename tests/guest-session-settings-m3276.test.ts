/**
 * M-3276 (the user, 11-17): a guest's sign-in length and idle sign-out, set in Settings → Access & security → Guests
 * instead of fleet.yaml only. `web.guests.session` { absolute_hours 1–24, idle_minutes 15–720, idle ≤ absolute }
 * (GUEST_SESSION_BOUNDS, default 12 h / 2 h) travels in the Guests draft as PUT /api/settings/fleet/web { guests: { session } }.
 * Lengthening either limit waits for a fleet admin; shortening applies at once; a value the store would not take as
 * written is never applied quietly. The page's own draft and checks are tested at the end.
 */
import { describe, expect, it } from "vitest";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { applyGuestsPatch, guestsPatch } from "../src/web-settings-patch.js";
import { validateFleetConfig } from "../src/config-validator.js";

const WEB = "/api/settings/fleet/web";
const FLEET = { channels: [{ id: "dc", type: "discord", group_id: "G", bot_token_env: "X" }], instances: { a: { working_directory: "/tmp" } } };
const judge = (guests: unknown, web: Record<string, unknown> = {}) =>
  prepareSettingsEffect("PUT", WEB, { guests }, { config: { defaults: {}, ...structuredClone(FLEET), web } as any, classic: {} }).diff;
const named = (d: any) => d?.summary.slice(1).join("\n") ?? "";

describe("M-3276: the guests patch carries the session limits", () => {
  it("parses { absolute_hours, idle_minutes } numbers and nulls; refuses anything else", () => {
    expect(guestsPatch({ session: { absolute_hours: 24, idle_minutes: 720 } })).toEqual({ session: { absolute_hours: 24, idle_minutes: 720 } });
    expect(guestsPatch({ session: { absolute_hours: null } })).toEqual({ session: { absolute_hours: null } });
    for (const bad of [{ session: 5 }, { session: [] }, { session: { absolute_hours: "24" } }, { session: { idle_hours: 2 } }, { session: { absolute_hours: Infinity } }]) {
      expect(guestsPatch(bad), JSON.stringify(bad)).toBe("invalid");
    }
  });
  it("merges into web.guests.session; null removes a key, an emptied session leaves; other guest keys untouched", () => {
    const one = applyGuestsPatch({ enabled: true, session: { absolute_hours: 6 } }, { session: { idle_minutes: 90 } });
    expect(one.next).toEqual({ enabled: true, session: { absolute_hours: 6, idle_minutes: 90 } });
    expect(one.changes).toEqual([{ path: ["web", "guests", "session", "idle_minutes"], value: 90 }]);
    const two = applyGuestsPatch({ enabled: true, session: { absolute_hours: 6 } }, { session: { absolute_hours: null } });
    expect(two.next).toEqual({ enabled: true });
    expect(two.changes).toEqual([{ path: ["web", "guests", "session", "absolute_hours"], value: undefined, remove: true }]);
  });
  it("the validator keeps judging the merged result: idle never above the absolute limit, both within bounds", () => {
    const errs = (session: unknown) => validateFleetConfig({ ...structuredClone(FLEET), web: { guests: { enabled: true, session } } } as any).errors
      .filter((e: any) => String(e.path ?? e).includes("guests.session")).length;
    expect(errs({ absolute_hours: 24, idle_minutes: 720 })).toBe(0);
    expect(errs({ absolute_hours: 2, idle_minutes: 180 })).toBeGreaterThan(0);
    expect(errs({ idle_minutes: 800 })).toBeGreaterThan(0);
  });
});

describe("M-3276: lengthening waits for a fleet admin, shortening applies at once", () => {
  it("longer than the default or than what is set: confirmed, each limit named", () => {
    expect(named(judge({ session: { absolute_hours: 24 } }))).toContain("fleet.web.guests.session.absolute\\_hours: default → 24");
    expect(named(judge({ session: { idle_minutes: 720 } }))).toContain("fleet.web.guests.session.idle\\_minutes: default → 720");
    expect(named(judge({ session: { absolute_hours: 12 } }, { guests: { session: { absolute_hours: 6 } } }))).toContain("absolute\\_hours: 6 → 12");
    expect(judge({ session: { absolute_hours: 24 } })?.section).toBe("access");
  });
  it("shorter, or back to a shorter default: applied without asking", () => {
    expect(judge({ session: { absolute_hours: 6 } })).toBeNull();
    expect(judge({ session: { idle_minutes: 30 } })).toBeNull();
    expect(judge({ session: { absolute_hours: null } }, { guests: { session: { absolute_hours: 24 } } })).toBeNull();
  });
  it("a value out of bounds is never applied: the merged config is refused outright", () => {
    expect(() => judge({ session: { absolute_hours: 100 } })).toThrow(/invalid_settings_effect/);
    expect(() => judge({ session: { absolute_hours: 2, idle_minutes: 180 } })).toThrow(/invalid_settings_effect/);
  });
  it("with another guest change that widens, only the widening limit and that change are named", () => {
    const d = judge({ enabled: true, session: { absolute_hours: 6, idle_minutes: 300 } });
    const text = named(d);
    expect(text).toContain("fleet.web.guests.enabled");
    expect(text).toContain("idle\\_minutes");
    expect(text).not.toContain("absolute\\_hours");
  });
});
