import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { createBackend } from "../src/backend/factory.js";
import { validateEffort } from "../src/backend/types.js";

/**
 * Per-CLI effort support, established by running each `--help` on 2026-08-02.
 * The notable one is kiro-cli: `--effort` lives on the `chat` SUBCOMMAND, so a
 * top-level help search misses it — the earlier "kiro has no effort" reading.
 */

describe("backend effort capabilities", () => {
  const cases: Array<[string, "runtime" | "restart" | "unsupported", string[]]> = [
    ["claude-code", "runtime", ["low", "medium", "high", "xhigh", "max"]],
    ["grok", "runtime", ["low", "medium", "high"]],
    ["antigravity", "runtime", ["low", "medium", "high"]],
    ["kiro-cli", "restart", ["low", "medium", "high", "xhigh", "max"]],
    ["codex", "restart", ["low", "medium", "high"]],
  ];

  it.each(cases)("%s → %s", (name, strategy, levels) => {
    const b = createBackend(name, mkdtempSync(join(tmpdir(), `eff-${name}-`)));
    expect(b.getEffortStrategy?.()).toBe(strategy);
    expect(b.getEffortLevels?.()).toEqual(levels);
  });

  it("opencode reports no effort support", () => {
    const b = createBackend("opencode", mkdtempSync(join(tmpdir(), "eff-oc-")));
    expect(b.getEffortStrategy?.() ?? "unsupported").toBe("unsupported");
  });
});

describe("clampEffort", () => {
  const THREE = ["low", "medium", "high"];
  const FIVE = ["low", "medium", "high", "xhigh", "max"];

  it("passes a supported level through untouched", () => {
    expect(FleetManager.clampEffort("high", THREE)).toBe("high");
    expect(FleetManager.clampEffort("max", FIVE)).toBe("max");
  });

  it("clamps DOWN the ladder, never up", () => {
    // `max` on a three-level CLI must become high, not low — and certainly not
    // something above what was asked for.
    expect(FleetManager.clampEffort("max", THREE)).toBe("high");
    expect(FleetManager.clampEffort("xhigh", THREE)).toBe("high");
  });

  it("returns null for a level outside the canonical ladder", () => {
    expect(FleetManager.clampEffort("turbo", FIVE)).toBeNull();
  });

  it("falls back to the lowest supported when nothing below the request exists", () => {
    expect(FleetManager.clampEffort("low", ["medium", "high"])).toBe("medium");
  });
});

describe("validateEffort", () => {
  it("accepts the canonical levels, case-insensitively", () => {
    for (const l of ["low", "MEDIUM", " high ", "xhigh", "max"]) {
      expect(() => validateEffort(l)).not.toThrow();
    }
    expect(validateEffort(" High ")).toBe("high");
  });

  it("rejects anything that could reach a shell command line", () => {
    // The value comes from a chat message and the launch command is a string.
    for (const bad of ["high; rm -rf /", "$(whoami)", "`id`", "high high", ""]) {
      expect(() => validateEffort(bad), bad).toThrow();
    }
  });
});

describe("applyEffort", () => {
  function makeFleet(backend: string, instances: Record<string, unknown> = { alpha: { working_directory: "/tmp" } }) {
    const dir = mkdtempSync(join(tmpdir(), "agend-effort-"));
    const fm = new FleetManager(dir);
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = { defaults: { backend }, instances };
    (fm as unknown as { saveFleetConfig(): void }).saveFleetConfig = () => {};
    return { fm, dir };
  }

  it("reports the clamp instead of silently downgrading", async () => {
    const { fm, dir } = makeFleet("antigravity");
    try {
      // agy tops out at high; asking for max must say what actually happened.
      const msg = await fm.applyEffort("alpha", "max");
      expect(msg).toContain("Clamped to");
      expect(msg).toContain("high");
      expect(msg).toContain("not supported by antigravity");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a backend with no effort setting", async () => {
    const { fm, dir } = makeFleet("opencode");
    try {
      expect(await fm.applyEffort("alpha", "high")).toContain("no reasoning-effort setting");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a level outside the canonical ladder", async () => {
    const { fm, dir } = makeFleet("claude-code");
    try {
      expect(await fm.applyEffort("alpha", "turbo")).toContain("Unknown effort level");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("persists the level even on the runtime path", async () => {
    const { fm, dir } = makeFleet("claude-code");
    try {
      await fm.applyEffort("alpha", "xhigh");
      // Without persisting, a runtime switch silently reverts on the next
      // respawn — the setting would look applied and then not be.
      const cfg = (fm as unknown as { fleetConfig: { instances: Record<string, { effort?: string }> } }).fleetConfig;
      expect(cfg.instances.alpha.effort).toBe("xhigh");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports not-running rather than pretending a runtime switch worked", async () => {
    const { fm, dir } = makeFleet("claude-code");
    try {
      // No IPC client registered → the paste cannot happen.
      expect(await fm.applyEffort("alpha", "high")).toContain("not running");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("resolveInstanceEffort", () => {
  it("prefers the instance value, falls back to the fleet default, else unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-effort-res-"));
    const fm = new FleetManager(dir);
    try {
      (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
        defaults: { backend: "claude-code", effort: "medium" },
        instances: { alpha: { working_directory: "/tmp", effort: "max" }, beta: { working_directory: "/tmp" } },
      };
      expect(fm.resolveInstanceEffort("alpha")).toEqual({ effort: "max", source: "instance" });
      expect(fm.resolveInstanceEffort("beta")).toEqual({ effort: "medium", source: "fleet-default" });

      (fm as unknown as { fleetConfig: unknown }).fleetConfig = { defaults: {}, instances: { beta: {} } };
      expect(fm.resolveInstanceEffort("beta")).toEqual({ effort: null, source: "unset" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
