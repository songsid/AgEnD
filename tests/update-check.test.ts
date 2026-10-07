import { describe, expect, it, vi } from "vitest";
import {
  compareSemver,
  getUpdateSelector,
  installedChannel,
  isPrereleaseVersion,
  isExactVersion,
  isUnrequestedDowngrade,
  updateNoticeKey,
  lookupTargetVersion,
  reportUpdateRestart,
  shouldSkipUpdate,
} from "../src/update-check.js";

describe("update version precheck", () => {
  it("selects an explicit version, then --beta, then --stable, else the installed version's channel", () => {
    expect(getUpdateSelector({}, "2.1.10")).toBe("latest");
    expect(getUpdateSelector({}, "2.1.10-beta.6")).toBe("beta");
    expect(getUpdateSelector({}, "v2.1.11-rc.1")).toBe("beta");
    expect(getUpdateSelector({ beta: true }, "2.1.10")).toBe("beta");
    expect(getUpdateSelector({ stable: true }, "2.1.10-beta.6")).toBe("latest");
    expect(getUpdateSelector({ beta: true, version: "2.1.0" }, "2.1.10-beta.6")).toBe("2.1.0");
    expect(getUpdateSelector({ stable: true, version: "2.1.0" }, "2.1.10")).toBe("2.1.0");
    // A source checkout's own package.json (1.22.0) is a plain release: latest, not a guess.
    expect(getUpdateSelector({}, "1.22.0")).toBe("latest");
  });

  it("the alpha channel (#1259): installed 2.1.12 / 2.1.12-beta.4 / 2.2.0-alpha.1 × no flag, --alpha, --beta, --stable, --version", () => {
    const table: Array<[string, Record<string, unknown>, string]> = [
      ["2.1.12", {}, "latest"], ["2.1.12-beta.4", {}, "beta"], ["2.2.0-alpha.1", {}, "alpha"],
      ["2.1.12", { alpha: true }, "alpha"], ["2.1.12-beta.4", { alpha: true }, "alpha"], ["2.2.0-alpha.1", { alpha: true }, "alpha"],
      ["2.1.12", { beta: true }, "beta"], ["2.1.12-beta.4", { beta: true }, "beta"], ["2.2.0-alpha.1", { beta: true }, "beta"],
      ["2.1.12", { stable: true }, "latest"], ["2.1.12-beta.4", { stable: true }, "latest"], ["2.2.0-alpha.1", { stable: true }, "latest"],
      ["2.2.0-alpha.1", { version: "2.2.0-alpha.1", alpha: true }, "2.2.0-alpha.1"],
    ];
    for (const [installed, opts, selector] of table) expect(getUpdateSelector(opts, installed), `${installed} ${JSON.stringify(opts)}`).toBe(selector);
  });

  it("which channel an install is on: only an `alpha` first identifier is alpha", () => {
    expect(installedChannel("2.2.0-alpha.1")).toBe("alpha");
    expect(installedChannel("v2.2.0-alpha.12")).toBe("alpha");
    expect(installedChannel("2.1.12-beta.4")).toBe("beta");
    expect(installedChannel("2.2.0-rc.1")).toBe("beta");
    expect(installedChannel("2.2.0-alphabet.1")).toBe("beta");
    expect(installedChannel("2.2.0-beta.1.alpha")).toBe("beta");
    expect(installedChannel("2.1.12")).toBe("latest");
    expect(installedChannel("garbage")).toBe("latest");
  });

  it("an alpha install is not moved back to an older @beta or @latest without asking", () => {
    expect(isUnrequestedDowngrade("2.2.0-alpha.1", "2.1.12-beta.9", { beta: true })).toBe(true);
    expect(isUnrequestedDowngrade("2.2.0-alpha.1", "2.1.12-beta.9", {})).toBe(true);
    expect(isUnrequestedDowngrade("2.2.0-alpha.1", "2.2.0-alpha.2", {})).toBe(false);
    expect(isUnrequestedDowngrade("2.1.12-beta.4", "2.2.0-alpha.1", { alpha: true })).toBe(false);
    expect(updateNoticeKey("2.2.0-alpha.1", "2.2.0")).toBe("update.available_stable");
    expect(updateNoticeKey("2.2.0-alpha.1", "2.2.0-alpha.2")).toBe("update.available_current");
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

describe("which channel an install is on, and which way an update goes", () => {
  it("a prerelease is x.y.z-<pre>, nothing looser: build metadata, a word that merely contains \"beta\", or garbage are not", () => {
    for (const v of ["2.1.10-beta.6", "v2.1.10-beta.6", "2.1.11-rc.1", "1.22.0-less", "3.0.0-0", "2.1.10-beta.6+sha.1"]) expect(isPrereleaseVersion(v), v).toBe(true);
    for (const v of ["2.1.10", "v2.1.10", "1.22.0", "2.1.10+beta", "betamax", "2.1.10beta", "2.1-beta.1", "", "0.0.0"]) expect(isPrereleaseVersion(v), v).toBe(false);
  });

  it("orders versions by semver: a prerelease below its release, numeric identifiers as numbers", () => {
    expect(compareSemver("2.1.10-beta.6", "2.1.10")!).toBeLessThan(0);
    expect(compareSemver("2.1.11-beta.2", "2.1.10")!).toBeGreaterThan(0);
    expect(compareSemver("2.1.10-beta.10", "2.1.10-beta.9")!).toBeGreaterThan(0);
    expect(compareSemver("2.1.10-beta.2", "2.1.10-beta")!).toBeGreaterThan(0);
    expect(compareSemver("2.1.10-alpha.1", "2.1.10-beta.1")!).toBeLessThan(0);
    expect(compareSemver("2.1.10-beta.1", "2.1.10-1")!).toBeGreaterThan(0);
    expect(compareSemver("2.10.0", "2.9.9")!).toBeGreaterThan(0);
    expect(compareSemver("v2.1.10", "2.1.10")).toBe(0);
    expect(compareSemver("2.1.10", "nonsense")).toBeNull();
  });

  it("refuses only an unrequested move to an older version", () => {
    // A beta install whose channel would land on an older stable: refused.
    expect(isUnrequestedDowngrade("2.1.11-beta.2", "2.1.10", {})).toBe(true);
    expect(isUnrequestedDowngrade("2.1.11-beta.2", "2.1.11-beta.1", { beta: true })).toBe(true);
    // Asked for: --stable, --version, --force.
    expect(isUnrequestedDowngrade("2.1.11-beta.2", "2.1.10", { stable: true })).toBe(false);
    expect(isUnrequestedDowngrade("2.1.11-beta.2", "2.1.10", { version: "2.1.10" })).toBe(false);
    expect(isUnrequestedDowngrade("2.1.11-beta.2", "2.1.10", { force: true })).toBe(false);
    // Same-line upgrades, and a beta's own release, are upgrades.
    expect(isUnrequestedDowngrade("2.1.11-beta.2", "2.1.11-beta.3", {})).toBe(false);
    expect(isUnrequestedDowngrade("2.1.10-beta.6", "2.1.10", {})).toBe(false);
    expect(isUnrequestedDowngrade("2.1.10", "2.1.11", {})).toBe(false);
    expect(isUnrequestedDowngrade("2.1.10", "2.1.10", {})).toBe(false);
    // Cannot be judged: not refused.
    expect(isUnrequestedDowngrade("2.1.11-beta.2", null, {})).toBe(false);
    expect(isUnrequestedDowngrade("1.22.0", "garbage", {})).toBe(false);
  });

  it("tells a beta install about a newer stable with --stable, and everything else with /update", () => {
    expect(updateNoticeKey("2.1.11-beta.2", "2.1.12")).toBe("update.available_stable");
    expect(updateNoticeKey("2.1.11-beta.2", "2.1.11-beta.3")).toBe("update.available_current");
    expect(updateNoticeKey("2.1.10", "2.1.11")).toBe("update.available_current");
  });

  it("takes only strict SemVer 2.0.0 (#1182 review): leading zeros and empty identifiers are not versions", () => {
    for (const v of ["01.2.3-beta.1", "2.1.11-beta.01", "2.1.11-beta.1+build..id", "2.1.11-beta.1+.", "2.1.10+build..id", "2.1.10-", "2.1.10-beta..1", "2.01.10"]) {
      expect(isExactVersion(v), v).toBe(false);
      expect(isPrereleaseVersion(v), v).toBe(false);
    }
    for (const v of ["0.0.0", "2.1.11-0", "2.1.11-01a", "2.1.10+001", " v2.1.10-beta.6 ", "2.1.11-x-y.0"]) expect(isExactVersion(v), v).toBe(true);
    // A version that does not parse cannot be judged older: not refused.
    expect(isUnrequestedDowngrade("2.1.11-beta.2", "2.1.10+build..id", {})).toBe(false);
  });

  it("compares numeric identifiers exactly, however large (#1182 review)", () => {
    expect(compareSemver("2.1.11-beta.9007199254740993", "2.1.11-beta.9007199254740992")).toBe(1);
    expect(compareSemver("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1);
    expect(compareSemver("2.1.11-beta.10", "2.1.11-beta.9")).toBe(1);
    expect(isUnrequestedDowngrade("2.1.11-beta.9007199254740993", "2.1.11-beta.9007199254740992", {})).toBe(true);
  });
});
