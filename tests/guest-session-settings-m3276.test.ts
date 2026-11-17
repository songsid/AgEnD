/**
 * M-3276 (the user, 11-17): a guest's sign-in length and idle sign-out, set in Settings → Access & security → Guests
 * instead of fleet.yaml only. `web.guests.session` { absolute_hours 1–720, idle_minutes 15–43200 (an admin's own bounds), idle ≤ absolute }
 * (GUEST_SESSION_BOUNDS, default 12 h / 2 h) travels in the Guests draft as PUT /api/settings/fleet/web { guests: { session } }.
 * Lengthening either limit waits for a fleet admin; shortening applies at once; a value the store would not take as
 * written is never applied quietly. The page's own draft and checks are tested at the end.
 */
import { describe, expect, it } from "vitest";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { applyGuestsPatch, guestsPatch } from "../src/web-settings-patch.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { GUEST_SESSION_BOUNDS, GUEST_SESSION_POLICY, LOCAL_SESSION_HOURS, WebSessionStore, guestSessionPolicy, localSessionPolicy } from "../src/web-session.js";
// @ts-expect-error a browser module without types
import { GUEST_SESSION, guestSessionCheck, guestsBody, savedGuests } from "../src/ui/settings-guests.js";

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
    expect(errs({ absolute_hours: 720, idle_minutes: 43200 })).toBe(0);                 // an admin's own maximum
    expect(errs({ absolute_hours: 721 })).toBeGreaterThan(0);
    expect(errs({ absolute_hours: 2, idle_minutes: 180 })).toBeGreaterThan(0);
    expect(errs({ idle_minutes: 800 })).toBeGreaterThan(0);                                // over the default 12 h length
    expect(errs({ absolute_hours: 720, idle_minutes: 43201 })).toBeGreaterThan(0);
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
    expect(() => judge({ session: { absolute_hours: 1000 } })).toThrow(/invalid_settings_effect/);
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

describe("M-3276: a guest's bounds are an admin's own; the surface still wins", () => {
  const H = 3_600_000, M = 60_000, EPOCH = "e".repeat(64), LINK = "a".repeat(32), ALICE = { adapterId: "tg", userId: "42" };
  const store = (local: { absolute_hours?: number; idle_hours?: number } | undefined, guests: { absolute_hours?: number; idle_minutes?: number }) => {
    const clock = { now: 1_800_000_000_000 };
    const s = new WebSessionStore({ now: () => clock.now, localPolicy: () => localSessionPolicy(local), guestPolicy: () => guestSessionPolicy(guests), exposureEnd: () => null });
    return { clock, s };
  };
  it("the bounds are LOCAL_SESSION_HOURS: 720 h and 720 h unused (in minutes)", () => {
    expect(GUEST_SESSION_BOUNDS).toEqual({ absoluteHours: { min: 1, max: LOCAL_SESSION_HOURS.max }, idleMinutes: { min: 15, max: LOCAL_SESSION_HOURS.max * 60 } });
    expect(guestSessionPolicy({ absolute_hours: 720, idle_minutes: 43200 })).toEqual({ absoluteMs: 720 * H, idleMs: 720 * H });
    expect(guestSessionPolicy({})).toEqual({ absoluteMs: 12 * H, idleMs: 2 * H });                      // the default is unchanged
  });
  it("on this computer never longer than an admin's own sign-in; over the link the link's limits", () => {
    const local = store({ absolute_hours: 48, idle_hours: 48 }, { absolute_hours: 720, idle_minutes: 43200 });
    const g = local.s.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: EPOCH, owner: ALICE }).record;
    expect([g.absoluteExpiry - local.clock.now, g.idleExpiry - local.clock.now]).toEqual([48 * H, 48 * H]);
    const wide = store({ absolute_hours: 720, idle_hours: 720 }, { absolute_hours: 720, idle_minutes: 43200 });
    const w = wide.s.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: EPOCH, owner: ALICE }).record;
    expect(w.absoluteExpiry - wide.clock.now).toBe(720 * H);
    const overLink = wide.s.create({ tier: "guest", surface: "gateway", label: "g", tokenEpoch: EPOCH, exposureId: LINK, owner: ALICE }).record;
    expect([overLink.absoluteExpiry - wide.clock.now, overLink.idleExpiry - wide.clock.now]).toEqual([8 * H, 30 * M]);
  });
});

describe("M-3276: the page's fields judge as the server does", () => {
  it("GUEST_SESSION mirrors GUEST_SESSION_BOUNDS and GUEST_SESSION_POLICY", () => {
    expect(GUEST_SESSION).toEqual({ absMin: GUEST_SESSION_BOUNDS.absoluteHours.min, absMax: GUEST_SESSION_BOUNDS.absoluteHours.max,
      idleMin: GUEST_SESSION_BOUNDS.idleMinutes.min, idleMax: GUEST_SESSION_BOUNDS.idleMinutes.max,
      absDefault: GUEST_SESSION_POLICY.absoluteMs / 3_600_000, idleDefault: GUEST_SESSION_POLICY.idleMs / 60_000 });
  });
  it("guestSessionCheck: bounds, idle over the length, what applies", () => {
    expect(guestSessionCheck({ sAbs: "720", sIdle: "43200" })).toEqual({ abs: "", idle: "", absNow: 720, idleNow: 43200 });
    expect(guestSessionCheck({ sAbs: "721", sIdle: "" }).abs).toBe("guestSessionAbsoluteRange");
    expect(guestSessionCheck({ sAbs: "", sIdle: "43201" }).idle).toBe("guestSessionIdleRange");
    expect(guestSessionCheck({ sAbs: "", sIdle: "800" }).idle).toBe("guestSessionIdleOver");                 // over the default 12 h
    expect(guestSessionCheck({ sAbs: "2", sIdle: "" })).toMatchObject({ abs: "", idle: "", absNow: 2, idleNow: 120 });
    expect(guestSessionCheck({ sAbs: "1", sIdle: "" }).idleNow).toBe(60);                                   // capped by the length
  });
  it("guestsBody: a changed field is sent, an emptied one as null; unchanged ones are not", () => {
    const saved = savedGuests({ web: { guests: { enabled: true, session: { absolute_hours: 24 } } } });
    expect(saved).toMatchObject({ sAbs: "24", sIdle: "" });
    expect(guestsBody(saved, { ...saved, sAbs: "720", sIdle: "600" })).toEqual({ body: { session: { absolute_hours: 720, idle_minutes: 600 } }, count: 2 });
    expect(guestsBody(saved, { ...saved, sAbs: "" })).toEqual({ body: { session: { absolute_hours: null } }, count: 1 });
    expect(guestsBody(saved, { ...saved })).toBeNull();
  });
});
