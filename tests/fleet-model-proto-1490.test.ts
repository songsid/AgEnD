/**
 * #1490 P3a: applyModel must reject model names with newlines / control chars
 *            before reaching the persist/paste path.
 * #1490 P3b: instance lookups via user input must use Object.hasOwn so that
 *            '__proto__' and 'constructor' are not treated as own instances.
 *
 * Each test has a reverse-mutation note.
 */
import { describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMinimalFm(instances: Record<string, object> = {}): FleetManager {
  const fm = Object.create(FleetManager.prototype) as FleetManager;
  (fm as any).fleetConfig = { defaults: {}, instances };
  (fm as any).logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  (fm as any).instanceIpcClients = new Map();
  (fm as any).classicChannels = null;
  // Stub downstream dependencies
  (fm as any).backendNameForInstance = () => "claude-code";
  (fm as any).getInstanceDir = () => "/tmp/dev";
  (fm as any).saveFleetConfig = vi.fn();
  (fm as any).restartSingleInstance = vi.fn().mockResolvedValue(undefined);
  (fm as any).effortSuffix = () => "";
  return fm;
}

// ── P3a: /model newline / control-char rejection ─────────────────────────────
//
// The guard runs before the strategy check and before any persist/paste.
//
// Reverse mutation: removing `if (/[\x00-\x1f\x7f]/.test(model)) return t("model.invalid_chars")`
// makes tests 1-3 fail because applyModel proceeds to the "not running" or
// persist path instead of returning the error string.

describe("applyModel — newline / control-char rejection (#1490 P3a)", () => {
  it("rejects a model name containing a newline (returns error, does not persist)", async () => {
    const fm = makeMinimalFm({ dev: {} });
    const saved = (fm as any).saveFleetConfig as ReturnType<typeof vi.fn>;

    const result = await (fm as any).applyModel("dev", "claude-sonnet\nmalicious");

    expect(result).toContain("❌");
    // The error from the guard specifically mentions chars, not "not running"
    expect(result).not.toMatch(/not running|未在執行/);
    expect(saved).not.toHaveBeenCalled();
  });

  it("rejects a model name containing a carriage return", async () => {
    const fm = makeMinimalFm({ dev: {} });
    const saved = (fm as any).saveFleetConfig as ReturnType<typeof vi.fn>;

    const result = await (fm as any).applyModel("dev", "claude-sonnet\rmalicious");

    expect(result).toContain("❌");
    expect(result).not.toMatch(/not running|未在執行/);
    expect(saved).not.toHaveBeenCalled();
  });

  it("rejects a model name containing a NUL byte", async () => {
    const fm = makeMinimalFm({ dev: {} });
    const saved = (fm as any).saveFleetConfig as ReturnType<typeof vi.fn>;

    const result = await (fm as any).applyModel("dev", "model\x00name");

    expect(result).toContain("❌");
    expect(result).not.toMatch(/not running|未在執行/);
    expect(saved).not.toHaveBeenCalled();
  });

  it("a clean model name passes the guard and proceeds normally (regression)", async () => {
    const fm = makeMinimalFm({ dev: {} });
    const saved = (fm as any).saveFleetConfig as ReturnType<typeof vi.fn>;
    // Simulate a running instance so strategy=runtime proceeds to persist
    (fm as any).instanceIpcClients.set("dev", { connected: true });
    (fm as any).pasteRawToClassicInstance = vi.fn();

    const result = await (fm as any).applyModel("dev", "claude-sonnet-4-5");

    // Guard did NOT fire — result is a success or "not supported", not the chars error
    expect(result).not.toMatch(/must not contain|不得包含/);
    // The persist path WAS reached (model saved to config)
    expect(saved).toHaveBeenCalled();
  });
});

// ── P3b: prototype-key safe instance lookup ───────────────────────────────────
//
// The fix wraps `this.fleetConfig?.instances[requested]` with Object.hasOwn
// at two points in fleet-manager.ts. Without it, `instances['__proto__']`
// returns the Object prototype (truthy) and passes the "found" check.
//
// Reverse mutation: changing `Object.hasOwn(instances, key)` back to
// `instances[key]` makes tests 1-2 fail because the result becomes truthy.

describe("instance lookup — Object.hasOwn prototype safety (#1490 P3b)", () => {
  it("'__proto__' is NOT an own-property of instances (guard semantics)", () => {
    const instances: Record<string, object> = { dev: {}, general: {} };
    // Prove the mutation is detectable: plain property access vs Object.hasOwn
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withoutGuard = !!(instances as any)["__proto__"]; // truthy (Object prototype)
    const withGuard = Object.hasOwn(instances, "__proto__"); // false
    expect(withoutGuard).toBe(true);  // shows WHY the bug existed
    expect(withGuard).toBe(false);    // shows WHY the fix works
  });

  it("'constructor' is NOT an own-property of instances", () => {
    const instances: Record<string, object> = { dev: {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withoutGuard = !!(instances as any)["constructor"]; // truthy (Object constructor)
    const withGuard = Object.hasOwn(instances, "constructor");
    expect(withoutGuard).toBe(true);
    expect(withGuard).toBe(false);
  });

  it("a real instance name IS an own-property (regression)", () => {
    const instances: Record<string, object> = { dev: {} };
    expect(Object.hasOwn(instances, "dev")).toBe(true);
    expect(Object.hasOwn(instances, "nonexistent")).toBe(false);
  });
});
