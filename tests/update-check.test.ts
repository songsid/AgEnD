import { describe, expect, it, vi } from "vitest";
import {
  getUpdateSelector,
  lookupTargetVersion,
  reportUpdateRestart,
  shouldSkipUpdate,
} from "../src/update-check.js";

describe("update version precheck", () => {
  it("selects latest, beta, or an explicit version independently", () => {
    expect(getUpdateSelector({})).toBe("latest");
    expect(getUpdateSelector({ beta: true })).toBe("beta");
    expect(getUpdateSelector({ beta: true, version: "2.1.0" })).toBe("2.1.0");
  });

  it("queries the matching npm dist-tag or explicit version", () => {
    const run = vi.fn().mockReturnValue("2.1.0-beta.7\n");

    expect(lookupTargetVersion("beta", run as any)).toBe("2.1.0-beta.7");
    expect(run).toHaveBeenCalledWith(
      "npm",
      ["view", "@songsid/agend@beta", "version"],
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it("skips an identical stable, beta, or explicit version", () => {
    expect(shouldSkipUpdate("2.1.0", "2.1.0")).toBe(true);
    expect(shouldSkipUpdate("2.1.0-beta.7", "2.1.0-beta.7")).toBe(true);
    expect(shouldSkipUpdate("2.1.0", "v2.1.0")).toBe(true);
  });

  it("does not skip when --force is set", () => {
    expect(shouldSkipUpdate("2.1.0", "2.1.0", true)).toBe(false);
  });

  it("continues the install flow when the registry lookup fails", () => {
    const run = vi.fn(() => {
      throw new Error("registry unavailable");
    });

    expect(lookupTargetVersion("latest", run as any)).toBeNull();
    expect(shouldSkipUpdate("2.1.0", null)).toBe(false);
  });

  it("reports restart failure prominently and returns failure", () => {
    const output = { log: vi.fn(), error: vi.fn() };

    expect(reportUpdateRestart(null, output)).toBe(false);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("Auto-restart FAILED"),
    );
    expect(output.error).toHaveBeenCalledWith("  Run: agend start");
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("agend status"),
    );
  });

  it("reports a successful restart without an error", () => {
    const output = { log: vi.fn(), error: vi.fn() };

    expect(reportUpdateRestart(0, output)).toBe(true);
    expect(output.log).toHaveBeenCalledWith("  ✓ Service restarted");
    expect(output.error).not.toHaveBeenCalled();
  });
});
