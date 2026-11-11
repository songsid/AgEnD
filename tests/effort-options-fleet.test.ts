/**
 * FleetManager.effortOptionsFor (AGEND-177, #3636 PR 2): what Settings → Runtime & model's effort field is offered. No CLI, no network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("FleetManager.effortOptionsFor: the levels the model in the field takes", { timeout: 60_000 }, () => {
  let root: string;
  const savedHome = process.env.AGEND_HOME;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-effort-field-")); process.env.AGEND_HOME = join(root, "agend"); });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });
  const rig = async (yaml: string) => {
    vi.resetModules();
    vi.doMock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }) }));
    const { FleetManager } = await import("../src/fleet-manager.js");
    const file = join(root, "fleet.yaml");
    writeFileSync(file, yaml);
    const fm = new FleetManager(root) as any;
    fm.loadConfig(file);
    return fm;
  };
  const catalog = () => {
    mkdirSync(join(root, "agend", "cli-env"), { recursive: true });
    writeFileSync(join(root, "agend", "cli-env", "claude-code.json"), JSON.stringify({ backend: "claude-code", probedAt: Date.now(), models: [], apiModels: [
      { id: "claude-opus-4-6", label: "x", effortLevels: ["low", "medium", "high", "max"] },
      { id: "claude-opus-4-5-20251101", label: "x", effortLevels: ["low", "medium", "high"] },
      { id: "claude-haiku-4-5-20251001", label: "x", effortLevels: [] },
    ] }));
  };
  const YAML = [
    "instances:",
    "  opus: { working_directory: /tmp, backend: claude-code, model: claude-opus-4-6 }",
    "  set: { working_directory: /tmp, backend: claude-code, model: claude-opus-4-6, effort: high }",
    "  oc: { working_directory: /tmp, backend: opencode }",
  ].join("\n");

  it("is the chip's list for the model it runs, and the model picked in the field's list instead when one is passed", async () => {
    catalog();
    const fm = await rig(YAML);
    expect(fm.effortOptionsFor("opus").levels).toEqual(fm.effortLevelsFor("opus"));
    expect(fm.effortOptionsFor("opus").levels).toEqual(["low", "medium", "high", "max"]);
    expect(fm.effortOptionsFor("opus", "claude-opus-4-5-20251101").levels).toEqual(["low", "medium", "high"]);
    expect(fm.effortOptionsFor("opus", "claude-opus-4-6[1m]").levels).toEqual(["low", "medium", "high", "max"]);
    expect(fm.effortOptionsFor("opus", "claude-haiku-4-5-20251001").levels).toEqual([]);   // no effort setting: nothing to offer
    expect(fm.effortOptionsFor("opus", "  ").levels).toEqual(["low", "medium", "high", "max"]);
  });

  it("codex: the model typed in the field is not asked about — the levels are the ones the chip and /effort apply against", async () => {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-a"\n');
    const lv = (...efforts: string[]) => efforts.map(effort => ({ effort }));
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({ models: [
      { slug: "gpt-a", supported_reasoning_levels: lv("low", "high") },
      { slug: "gpt-b", supported_reasoning_levels: lv("low", "medium", "high", "xhigh") },
    ] }));
    const savedCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const fm = await rig(["instances:", "  cx: { working_directory: /tmp, backend: codex }"].join("\n"));
      expect(fm.effortLevelsFor("cx")).toEqual(["low", "high"]);
      expect(fm.effortOptionsFor("cx").levels).toEqual(["low", "high"]);
      expect(fm.effortOptionsFor("cx", "gpt-b").levels).toEqual(["low", "high"]);   // the field's model is not what /effort applies against
      expect(fm.effortOptionsFor("cx", "gpt-b").levels).toEqual(fm.effortLevelsFor("cx"));
    } finally {
      if (savedCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodex;
    }
  });

  it("answers the effort in force with its source, and offers nothing for a CLI without an effort setting or an unknown agent", async () => {
    catalog();
    const fm = await rig(YAML);
    expect(fm.effortOptionsFor("opus")).toMatchObject({ effort: null, source: "unset" });
    expect(fm.effortOptionsFor("set")).toMatchObject({ effort: "high", source: "instance" });
    expect(fm.effortOptionsFor("oc").levels).toEqual([]);
    expect(fm.effortOptionsFor("nobody").levels).toEqual([]);
  });
});
