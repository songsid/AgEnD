/**
 * #2850 (user, 2026-10-29): a session over the temporary public link lasts as long as the link, at most 8 h, never longer
 * than the tier's own policy (an admin's web.session.local, a guest's web.guests.session); 30 min unused still ends it.
 */
import { describe, expect, it } from "vitest";
import { WebSessionStore, guestSessionPolicy, localSessionPolicy } from "../src/web-session.js";

const H = 3_600_000, M = 60_000;
const EPOCH = "e".repeat(64);
const LINK = "a".repeat(32), OTHER = "b".repeat(32);
const ALICE = { adapterId: "tg", userId: "42" };

function rig(opts: { linkMinutes?: number | null; local?: { absolute_hours?: number; idle_hours?: number }; guests?: { absolute_hours?: number; idle_minutes?: number } } = {}) {
  const clock = { now: 1_800_000_000_000 };
  const linkEnd = opts.linkMinutes === null ? null : clock.now + (opts.linkMinutes ?? 480) * M;
  const store = new WebSessionStore({
    now: () => clock.now,
    localPolicy: () => localSessionPolicy(opts.local),
    guestPolicy: () => guestSessionPolicy(opts.guests),
    exposureEnd: id => id === LINK ? linkEnd : null,
  });
  const admin = () => store.create({ tier: "admin", surface: "gateway", label: "a", tokenEpoch: EPOCH, exposureId: LINK });
  const guest = () => store.create({ tier: "guest", surface: "gateway", label: "g", tokenEpoch: EPOCH, exposureId: LINK, owner: ALICE });
  // Use it every 20 min (inside the 30-min idle window) until it ends; returns how long it lasted.
  const lasts = (sessionId: string): number => {
    const start = clock.now;
    while (store.authenticate(sessionId, EPOCH, { surface: "gateway", exposureId: LINK })) clock.now += 20 * M;
    return clock.now - start;
  };
  return { clock, store, admin, guest, lasts };
}

describe("#2850: a public-link session lasts as long as the link, up to 8 h", () => {
  it("an admin over a 480-min link ends at 8 h, not 4 h (kept in use)", () => {
    const r = rig({ linkMinutes: 480 });
    const { sessionId, record } = r.admin();
    expect(record.absoluteExpiry - r.clock.now).toBe(8 * H);
    expect(record.idleExpiry - r.clock.now, "idle stays 30 min").toBe(30 * M);
    const lasted = r.lasts(sessionId);
    expect(lasted).toBeGreaterThan(4 * H);
    expect(lasted).toBeLessThanOrEqual(8 * H);
    expect(lasted).toBeGreaterThan(8 * H - 20 * M);
  });
  it("a link without an expiry (named tunnel) still caps it at 8 h", () => {
    const r = rig({ linkMinutes: null });
    expect(r.admin().record.absoluteExpiry - r.clock.now).toBe(8 * H);
  });
  it("a 120-min link: the session ends with the link", () => {
    const r = rig({ linkMinutes: 120 });
    const { sessionId, record } = r.admin();
    expect(record.absoluteExpiry - r.clock.now).toBe(120 * M);
    const lasted = r.lasts(sessionId);
    expect(lasted).toBeLessThanOrEqual(120 * M);
    expect(lasted).toBeGreaterThan(100 * M);
  });
  it("a guest with web.guests.session.absolute_hours 4 stays at 4 h; a default guest gets 8 h", () => {
    const four = rig({ guests: { absolute_hours: 4 } });
    const g = four.guest();
    expect([g.record.absoluteExpiry - four.clock.now, g.record.idleExpiry - four.clock.now]).toEqual([4 * H, 30 * M]);
    expect(four.lasts(g.sessionId)).toBeLessThanOrEqual(4 * H);
    const def = rig();
    expect(def.guest().record.absoluteExpiry - def.clock.now, "default guest 12 h → the link's 8 h").toBe(8 * H);
  });
  it("an admin's own web.session.local caps it too", () => {
    const r = rig({ local: { absolute_hours: 2, idle_hours: 2 } });
    expect(r.admin().record.absoluteExpiry - r.clock.now).toBe(2 * H);
  });
  it("30 min unused still ends it", () => {
    const r = rig();
    const { sessionId } = r.admin();
    r.clock.now += 30 * M + 1;
    expect(r.store.authenticate(sessionId, EPOCH, { surface: "gateway", exposureId: LINK })).toBeNull();
  });
  it("the link's end applies only to sessions made over that link", () => {
    const r = rig({ linkMinutes: 60 });
    const other = r.store.create({ tier: "admin", surface: "gateway", label: "a", tokenEpoch: EPOCH, exposureId: OTHER }).record;
    expect(other.absoluteExpiry - r.clock.now).toBe(8 * H);
    const local = r.store.create({ tier: "admin", surface: "local", label: "l", tokenEpoch: EPOCH }).record;
    expect(local.absoluteExpiry - r.clock.now).toBe(48 * H);
  });
});
