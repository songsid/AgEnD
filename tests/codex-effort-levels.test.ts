import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend } from "../src/backend/codex.js";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * Codex effort levels are per model, published in models_cache.json as
 * `supported_reasoning_levels`. Verified against a live cache on 2026-08-03:
 * gpt-5.6-sol/-terra go up to `ultra`, gpt-5.6-luna to `max`, the 5.4/5.5
 * family to `xhigh`. The old static ["low","medium","high"] under-reported
 * every one of them — /effort refused `xhigh` for gpt-5.5, whose own DEFAULT
 * is xhigh. And the CLI does not validate `model_reasoning_effort` (a bogus
 * value launches fine, verified live), so this list is the only guard rail.
 */

let codexHome: string;
let instanceDir: string;
const realCodexHome = process.env.CODEX_HOME;

function writeCache(models: unknown[]): void {
  writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({ models }));
}

const model = (slug: string, efforts: string[]) => ({
  slug,
  visibility: "list",
  supported_reasoning_levels: efforts.map(e => ({ effort: e, description: e })),
});

function backendFor(modelSlug: string | undefined): CodexBackend {
  const b = new CodexBackend(instanceDir);
  if (modelSlug) {
    b.buildCommand({ model: modelSlug, mcpServers: {} } as never);
  }
  return b;
}

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "agend-codex-home-"));
  instanceDir = mkdtempSync(join(tmpdir(), "agend-codex-inst-"));
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
});
afterEach(() => {
  if (realCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = realCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(instanceDir, { recursive: true, force: true });
});

describe("CodexBackend.getEffortLevels", () => {
  it("returns the configured model's own levels from the cache", () => {
    writeCache([
      model("gpt-5.5", ["low", "medium", "high", "xhigh"]),
      model("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]),
    ]);
    expect(backendFor("gpt-5.5").getEffortLevels()).toEqual(["low", "medium", "high", "xhigh"]);
    expect(backendFor("gpt-5.6-luna").getEffortLevels()).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("filters levels the fleet ladder does not know, instead of offering one the pipeline rejects", () => {
    // gpt-5.6-sol reports `ultra`; validateEffort and clampEffort know low…max.
    writeCache([model("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"])]);
    expect(backendFor("gpt-5.6-sol").getEffortLevels()).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("falls back to the model line in config.toml when no launch has happened", () => {
    writeCache([model("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"])]);
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\n');
    expect(backendFor(undefined).getEffortLevels()).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("falls back to low…xhigh when the cache or the model entry is missing", () => {
    // xhigh is the floor every catalog model supports today; the old list's
    // ceiling of `high` refused a level even gpt-5.4-mini accepts.
    expect(backendFor("gpt-9-unknown").getEffortLevels()).toEqual(["low", "medium", "high", "xhigh"]);

    writeCache([model("something-else", ["low"])]);
    expect(backendFor("gpt-9-unknown").getEffortLevels()).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("survives a corrupt cache", () => {
    writeFileSync(join(codexHome, "models_cache.json"), "{not json");
    expect(backendFor("gpt-5.5").getEffortLevels()).toEqual(["low", "medium", "high", "xhigh"]);
  });
});

describe("what /effort now offers for codex", () => {
  it("clamps max down to a 5.4-family model's xhigh instead of refusing", () => {
    writeCache([model("gpt-5.4", ["low", "medium", "high", "xhigh"])]);
    const supported = backendFor("gpt-5.4").getEffortLevels();
    expect(FleetManager.clampEffort("max", supported)).toBe("xhigh");
    // Under the old static list this clamped all the way down to high —
    // a silently weaker setting than the model supports.
    expect(FleetManager.clampEffort("max", ["low", "medium", "high"])).toBe("high");
  });
});
