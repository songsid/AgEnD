/**
 * #1670: the default local web session is 48 h absolute / 48 h idle ("兩天內都不用重登", user 2026-10-12). The public
 * link stays 4 h / 30 min; bounds stay 1–720; an explicit `web.session.local.*` still wins. A session signed in before
 * the change keeps its recorded absolute end (it is never raised); only its idle window moves on its next use, up to
 * that end (#1620's rule).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SESSION_POLICY, WebSessionStore, localSessionPolicy } from "../src/web-session.js";
import { validateFleetConfig } from "../src/config-validator.js";

const H = 3_600_000, M = 60_000;
const EPOCH = "e".repeat(64);   // a token epoch is a hash: the loader drops a record with anything else
const input = { tier: "admin" as const, surface: "local" as const, label: "test", tokenEpoch: EPOCH };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const errorsOf = (web: unknown): string[] => validateFleetConfig({ instances: {}, web }).errors.map(e => `${e.path}: ${e.message}`);

describe("#1670: the default local session is 48 h / 48 h", () => {
  it("the default policy is 48 h absolute, 48 h idle; the public link's stays 4 h / 30 min", () => {
    expect(DEFAULT_SESSION_POLICY.local).toEqual({ absoluteMs: 48 * H, idleMs: 48 * H });
    expect(DEFAULT_SESSION_POLICY.gateway).toEqual({ absoluteMs: 4 * H, idleMs: 30 * M });
  });

  it("a missing config gives 48 / 48 — no web.session at all, an empty one, or a store with no policy given", () => {
    for (const cfg of [undefined, {}]) expect(localSessionPolicy(cfg), JSON.stringify(cfg)).toEqual({ absoluteMs: 48 * H, idleMs: 48 * H });
    const store = new WebSessionStore({ now: () => 1_000_000 });
    expect(store.idleWindowMs("local")).toBe(48 * H);
    const { record } = store.create(input);
    expect([record.absoluteExpiry - record.created, record.idleExpiry - record.created]).toEqual([48 * H, 48 * H]);
  });

  it("an invalid value falls back to 48 (never looser than the default): not a number, above 720", () => {
    for (const bad of [Number.NaN, 9999, "24", null, Number.POSITIVE_INFINITY]) {
      expect(localSessionPolicy({ absolute_hours: bad }).absoluteMs, String(bad)).toBe(48 * H);
      expect(localSessionPolicy({ idle_hours: bad }).idleMs, String(bad)).toBe(48 * H);
    }
  });

  it("an explicit shorter value still wins", () => {
    expect(localSessionPolicy({ absolute_hours: 12, idle_hours: 2 })).toEqual({ absoluteMs: 12 * H, idleMs: 2 * H });
    expect(localSessionPolicy({ absolute_hours: 24 })).toEqual({ absoluteMs: 24 * H, idleMs: 24 * H });   // idle follows it
    expect(localSessionPolicy({ idle_hours: 1 })).toEqual({ absoluteMs: 48 * H, idleMs: 1 * H });
    const store = new WebSessionStore({ now: () => 1_000_000, localPolicy: () => localSessionPolicy({ absolute_hours: 6, idle_hours: 1 }) } as never);
    expect(store.idleWindowMs("local")).toBe(1 * H);
  });

  it("idle_hours: 60 alone is refused against the 48 h default; a shorter absolute_hours alone stays valid (idle follows it)", () => {
    expect(errorsOf({ session: { local: { idle_hours: 60 } } })).toEqual(["web.session.local.idle_hours: must not exceed absolute_hours (60 > 48, the default)"]);
    expect(errorsOf({ session: { local: { idle_hours: 48 } } })).toEqual([]);
    expect(errorsOf({ session: { local: { absolute_hours: 24 } } })).toEqual([]);
    expect(errorsOf({ session: { local: { absolute_hours: 72, idle_hours: 60 } } })).toEqual([]);
    expect(errorsOf({ session: { local: { absolute_hours: 24, idle_hours: 30 } } })).toEqual(["web.session.local.idle_hours: must not exceed absolute_hours (30 > 24)"]);
  });

  it("a session signed in before the change keeps its recorded end on load — never raised — and still ends then", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1670-")); dirs.push(dir);
    let now = 1_000_000;
    // Signed in under the old default (12 h / 2 h), persisted.
    const before = new WebSessionStore({ dataDir: dir, now: () => now, policy: { local: { absoluteMs: 12 * H, idleMs: 2 * H } } });
    const { sessionId, record: old } = before.create(input);
    const onDisk = () => JSON.parse(readFileSync(join(dir, "web-sessions.json"), "utf8")).sessions[0];
    expect([onDisk().absoluteExpiry, onDisk().idleExpiry]).toEqual([old.created + 12 * H, old.created + 2 * H]);

    // The fleet now runs with the 48 h default: loading and checking never raises the recorded absolute end.
    now += 1 * H;
    const after = new WebSessionStore({ dataDir: dir, now: () => now });
    const loaded = after.authenticate(sessionId, EPOCH, { touch: false });
    expect(loaded?.absoluteExpiry).toBe(old.created + 12 * H);
    expect(loaded?.idleExpiry).toBe(old.created + 2 * H);           // a passive check does not move it either
    // A real use moves the idle window by the new 48 h — capped by the unchanged absolute end (#1620's rule).
    const used = after.authenticate(sessionId, EPOCH);
    expect([used?.absoluteExpiry, used?.idleExpiry]).toEqual([old.created + 12 * H, old.created + 12 * H]);
    // …so it still ends 12 h after its sign-in, although new sign-ins now get 48 h.
    now = old.created + 12 * H;
    expect(after.authenticate(sessionId, EPOCH)).toBeNull();
    expect(after.create(input).record.absoluteExpiry - now).toBe(48 * H);
  });
});
