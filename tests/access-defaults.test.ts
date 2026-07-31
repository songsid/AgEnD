import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessManager } from "../src/channel/access-manager.js";
import { FleetManager } from "../src/fleet-manager.js";
import { validateFleetConfig } from "../src/config-validator.js";
import type { AccessConfig, ChannelConfig } from "../src/types.js";

// An omitted `access:` block used to mean "open to every user on the platform",
// and a partial one inherited zero-valued limits that disabled both code expiry
// (NaN arithmetic) and the pairing quota. These tests pin the new defaults and,
// importantly, that an existing deployment is not locked out by the tightening.

const statePath = () => join(mkdtempSync(join(tmpdir(), "agend-access-")), "access.json");

type Internals = {
  resolveAccessConfig(ch: ChannelConfig, statePath: string, adapterId: string): AccessConfig;
};

/** A data dir that looks like a fresh install (no instances/ entries). */
function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "agend-fresh-"));
}

/** A data dir that looks like an existing deployment (has run instances). */
function legacyDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-legacy-"));
  mkdirSync(join(dir, "instances", "alpha"), { recursive: true });
  return dir;
}

const channel = (access?: Partial<AccessConfig>): ChannelConfig =>
  ({ type: "telegram", bot_token_env: "TOK", ...(access ? { access: access as AccessConfig } : {}) }) as ChannelConfig;

describe("AccessManager limits", () => {
  it("expires pairing codes when code_expiry_minutes is positive", () => {
    const path = statePath();
    const am = new AccessManager({ mode: "pairing", allowed_users: [], max_pending_codes: 3, code_expiry_minutes: 10 }, path);
    const code = am.generateCode("user-a");
    expect(am.confirmCode(code)).toBe(true);
  });

  it("enforces the pending-code quota when max_pending_codes is positive", () => {
    const am = new AccessManager({ mode: "pairing", allowed_users: [], max_pending_codes: 1, code_expiry_minutes: 10 }, statePath());
    am.generateCode("user-a");
    expect(() => am.generateCode("user-b")).toThrow(/Max pending codes/);
  });

  it("documents why zero limits were a bug: pairing could not issue any code", () => {
    // The previous fallback passed max_pending_codes: 0, so the guard
    // `usersWithPending.size >= 0` tripped on the very first request — `mode:
    // pairing` was unusable, and code_expiry_minutes: 0 made expiry arithmetic NaN
    // so nothing was ever pruned. Kept as an executable record of the old defaults.
    const am = new AccessManager({ mode: "pairing", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 0 }, statePath());
    expect(() => am.generateCode("user-a")).toThrow(/Max pending codes/);
  });

  it("locked rejects unknown users; open accepts them", () => {
    const locked = new AccessManager({ mode: "locked", allowed_users: [], max_pending_codes: 3, code_expiry_minutes: 10 }, statePath());
    expect(locked.isAllowed("12345")).toBe(false);
    const open = new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 3, code_expiry_minutes: 10 }, statePath());
    expect(open.isAllowed("12345")).toBe(true);
  });
});

describe("FleetManager.resolveAccessConfig", () => {
  it("fills in the documented limits for a partial block", () => {
    const fm = new FleetManager(freshDataDir()) as unknown as Internals;
    const resolved = fm.resolveAccessConfig(channel({ mode: "pairing" }), statePath(), "tg");
    expect(resolved.mode).toBe("pairing");
    expect(resolved.max_pending_codes).toBe(3);
    expect(resolved.code_expiry_minutes).toBe(10);
  });

  it("never overrides an explicit mode", () => {
    const fm = new FleetManager(legacyDataDir()) as unknown as Internals;
    expect(fm.resolveAccessConfig(channel({ mode: "open" }), statePath(), "tg").mode).toBe("open");
    expect(fm.resolveAccessConfig(channel({ mode: "locked" }), statePath(), "tg").mode).toBe("locked");
  });

  it("a fresh install with no access block fails closed", () => {
    const fm = new FleetManager(freshDataDir()) as unknown as Internals;
    expect(fm.resolveAccessConfig(channel(), statePath(), "tg").mode).toBe("locked");
  });

  it("an existing deployment with no access block keeps working (no lockout on upgrade)", () => {
    // AccessManager only writes its state file once something changes, so a fleet
    // that ran on the old open fallback without pairing anyone has no saved mode.
    // Tightening it here would make the operator's own bot stop answering.
    const fm = new FleetManager(legacyDataDir()) as unknown as Internals;
    expect(fm.resolveAccessConfig(channel(), statePath(), "tg").mode).toBe("open");
  });

  it("existing access state means the saved mode governs, whatever we pass", () => {
    const path = statePath();
    const seed = new AccessManager({ mode: "open", allowed_users: ["111"], max_pending_codes: 3, code_expiry_minutes: 10 }, path);
    seed.setMode("open"); // forces a persist, so the state file exists
    const fm = new FleetManager(freshDataDir()) as unknown as Internals;
    const resolved = fm.resolveAccessConfig(channel(), path, "tg");
    const reopened = new AccessManager(resolved, path);
    expect(reopened.getMode()).toBe("open");
    expect(reopened.isAllowed("111")).toBe(true);
  });

  it("fills allowed_users so a partial block cannot reach AccessManager as undefined", () => {
    const fm = new FleetManager(freshDataDir()) as unknown as Internals;
    const resolved = fm.resolveAccessConfig(channel({ mode: "pairing" }), statePath(), "tg");
    expect(resolved.allowed_users).toEqual([]);
    expect(() => new AccessManager(resolved, statePath())).not.toThrow();
  });
});

describe("validateFleetConfig — access block", () => {
  const cfg = (access?: unknown) => ({
    channel: { type: "telegram", bot_token_env: "TOK", ...(access !== undefined ? { access } : {}) },
    defaults: {},
    instances: {},
  });

  it("warns when the access block is absent", () => {
    const r = validateFleetConfig(cfg());
    expect(r.errors).toHaveLength(0);
    expect(r.warnings.some(w => w.path.endsWith(".access"))).toBe(true);
  });

  it("rejects a non-mapping access block", () => {
    expect(validateFleetConfig(cfg("open")).errors.some(e => e.path === "channel.access")).toBe(true);
  });

  it("rejects non-positive limits", () => {
    const r = validateFleetConfig(cfg({ mode: "pairing", max_pending_codes: 0, code_expiry_minutes: -5 }));
    expect(r.errors.some(e => e.path === "channel.access.max_pending_codes")).toBe(true);
    expect(r.errors.some(e => e.path === "channel.access.code_expiry_minutes")).toBe(true);
  });

  it("warns about a locked channel nobody can reach", () => {
    const r = validateFleetConfig(cfg({ mode: "locked", allowed_users: [] }));
    expect(r.warnings.some(w => w.message.includes("nobody can reach"))).toBe(true);
  });

  it("accepts a well-formed block without complaint", () => {
    const r = validateFleetConfig(cfg({ mode: "locked", allowed_users: [123, "456"] }));
    expect(r.errors).toHaveLength(0);
    expect(r.warnings.some(w => w.path.endsWith(".access"))).toBe(false);
  });
});
