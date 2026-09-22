import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AccessManager } from "../../src/channel/access-manager.js";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("AccessManager", () => {
  let tmpDir: string;
  let am: AccessManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-access-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    am = new AccessManager(
      { mode: "pairing", allowed_users: [111], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "access.json"),
    );
  });

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("allows known users", () => { expect(am.isAllowed(111)).toBe(true); });
  it("rejects unknown users", () => { expect(am.isAllowed(999)).toBe(false); });

  it("rejects unknown users in locked mode", () => {
    am.setMode("locked");
    expect(am.isAllowed(999)).toBe(false);
  });

  it("generates 8-char hex pairing code", () => {
    const code = am.generateCode(999);
    expect(code).toMatch(/^[0-9A-F]{8}$/);
  });

  it("confirms valid pairing code and adds to allowlist", () => {
    const code = am.generateCode(999);
    expect(am.confirmCode(code)).toBe(true);
    expect(am.isAllowed(999)).toBe(true);
  });

  it("rejects invalid pairing code", () => {
    expect(am.confirmCode("ZZZZZZ")).toBe(false);
  });

  it("limits pairing attempts per user to 2", () => {
    am.generateCode(999);
    am.generateCode(999);
    expect(am.hasPairingQuota(999)).toBe(false);
    expect(() => am.generateCode(999)).toThrow();
  });

  it("limits total pending codes to max_pending_codes unique users", () => {
    am.generateCode(100);
    am.generateCode(200);
    am.generateCode(300);
    expect(() => am.generateCode(400)).toThrow(/max pending/i);
  });

  it("persists mode across instances", () => {
    am.setMode("locked");
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: [111], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "access.json"),
    );
    expect(am2.getMode()).toBe("locked");
  });

  it("persists allowlist across instances", () => {
    const code = am.generateCode(999);
    am.confirmCode(code);
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: [111], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "access.json"),
    );
    expect(am2.isAllowed(999)).toBe(true);
  });

  it("removes user from allowlist", () => {
    expect(am.removeUser(111)).toBe(true);
    expect(am.isAllowed(111)).toBe(false);
  });

  // String/number cross-type matching (Bug: snowflake fix regression)
  it("isAllowed matches number userId against string allowlist", () => {
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: ["111", "222"], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "cross-type.json"),
    );
    // Telegram sends number, YAML/wizard may store string
    expect(am2.isAllowed(111)).toBe(true);
    expect(am2.isAllowed("111")).toBe(true);
    expect(am2.isAllowed(999)).toBe(false);
  });

  it("isAllowed matches string userId against number allowlist", () => {
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: [111, 222], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "cross-type2.json"),
    );
    // Discord sends string
    expect(am2.isAllowed("111")).toBe(true);
    expect(am2.isAllowed(111)).toBe(true);
  });

  it("removeUser works across types", () => {
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: ["111"], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "cross-remove.json"),
    );
    expect(am2.removeUser(111)).toBe(true); // number removes string entry
    expect(am2.isAllowed("111")).toBe(false);
  });

  it("constructor deduplicates across types", () => {
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: [111, "111", 222], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "cross-dedup.json"),
    );
    expect(am2.getAllowedUsers()).toHaveLength(2); // 111 and 222, not 111, "111", 222
  });
});

describe("AccessManager state vs fleet.yaml", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-access-override-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    statePath = join(tmpDir, "access.json");
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  const config = (mode: "pairing" | "locked" | "open") =>
    ({ mode, allowed_users: [], max_pending_codes: 3, code_expiry_minutes: 60 });

  const manager = (mode: "pairing" | "locked" | "open") => new AccessManager(config(mode), statePath);

  it("says which configured mode the state file is overriding", () => {
    // What a user hits: they paired someone while the fleet was open, which
    // wrote the mode into the file, then edited fleet.yaml to locked and saw
    // nothing change.
    writeFileSync(statePath, JSON.stringify({ mode: "open", allowed_users: [], pending_codes: [] }));
    const am = manager("locked");

    expect(am.getMode()).toBe("open");
    expect(am.overriddenConfigMode()).toBe("locked");
  });

  it("reports nothing when the two agree", () => {
    writeFileSync(statePath, JSON.stringify({ mode: "locked", allowed_users: [], pending_codes: [] }));
    expect(manager("locked").overriddenConfigMode()).toBeNull();
  });

  it("reports nothing when the state file has no mode of its own", () => {
    // Written by an older version, or by a persist that predates any setMode.
    writeFileSync(statePath, JSON.stringify({ allowed_users: [222], pending_codes: [] }));
    const am = manager("pairing");

    expect(am.getMode()).toBe("pairing");
    expect(am.overriddenConfigMode()).toBeNull();
  });

  it("reports nothing before anything has been persisted", () => {
    expect(manager("open").overriddenConfigMode()).toBeNull();
  });

  it("starts reporting an override once the mode is changed at runtime and reloaded", () => {
    // The trap is not the first process; it is the next one. setMode persists,
    // and from then on fleet.yaml is not what decides.
    manager("open").setMode("locked");

    const reloaded = manager("open");
    expect(reloaded.getMode()).toBe("locked");
    expect(reloaded.overriddenConfigMode()).toBe("open");
  });

  it("keeps the persisted mode in effect — the report does not change behaviour", () => {
    // State winning is deliberate: a pairing done at runtime must survive a
    // restart. This test exists so a future "fix" that flips the precedence
    // has to change it on purpose.
    writeFileSync(statePath, JSON.stringify({ mode: "open", allowed_users: [], pending_codes: [] }));
    const am = manager("locked");

    expect(am.getMode()).toBe("open");
    expect(am.isAllowed(999), "open mode admits an unknown user").toBe(true);
  });
});
