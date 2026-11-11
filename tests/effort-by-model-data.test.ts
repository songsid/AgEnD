/**
 * The data layer behind per-model effort (AGEND-176, #3624 follow-up): claude's account catalog gives each model its
 * `capabilities.effort`, grok's models_cache.json its `reasoning_efforts`, and `effortLevelsFor` / readEffortMetadata
 * answer with the running model's own levels. Anything unreadable keeps the old behaviour. No CLI, no network.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/usage/providers.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/usage/providers.js")>(),
  getClaudeOAuthToken: vi.fn(async () => "token"),
}));

import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { GROK_FALLBACK_MODELS, GrokBackend } from "../src/backend/grok.js";
import { parseClaudeEffortCapability, readClaudeEffortLevels, readEffortMetadata, readGrokEffortLevels } from "../src/backend/effort-metadata.js";
import { flagEffort } from "../src/backend/launch-effort.js";
// @ts-expect-error — a JS module of the app, with no types
import { EFFORT_BACKENDS, effectiveSummary } from "../src/ui/settings-model.js";
import { registerExecutableFixture } from "./support/process-guard.js";

const eff = (...levels: string[]) => ({ supported: true, ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map(l => [l, { supported: levels.includes(l) }])) });
const API = [
  { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1_000_000, capabilities: { effort: eff("low", "medium", "high", "xhigh", "max") } },
  { id: "claude-opus-4-6", display_name: "Claude Opus 4.6", max_input_tokens: 1_000_000, capabilities: { effort: eff("low", "medium", "high", "max") } },
  { id: "claude-opus-4-5-20251101", display_name: "Claude Opus 4.5", max_input_tokens: 200_000, capabilities: { effort: eff("low", "medium", "high") } },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200_000, capabilities: { effort: { supported: false } } },
  { id: "claude-legacy-x", display_name: "No capabilities" },
];

let root: string;
const savedHome = process.env.AGEND_HOME, savedGrok = process.env.GROK_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-effort-by-model-"));
  process.env.AGEND_HOME = join(root, "agend");
  process.env.GROK_HOME = join(root, "grok");
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedHome;
  if (savedGrok === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = savedGrok;
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

const cliEnv = (backend: string, env: Record<string, unknown>, file = backend) => {
  mkdirSync(join(root, "agend", "cli-env"), { recursive: true });
  writeFileSync(join(root, "agend", "cli-env", `${file}.json`), JSON.stringify({ backend, probedAt: Date.now(), models: [], ...env }));
};
const grokCache = (models: Record<string, unknown>) => {
  mkdirSync(join(root, "grok"), { recursive: true });
  writeFileSync(join(root, "grok", "models_cache.json"), JSON.stringify({ identity: { access_token: "SECRET" }, models }));
};
const rungs = (...levels: string[]) => levels.map(value => ({ id: value, value, label: value, default: value === "high" }));
const GROK = {
  "grok-4.7": { info: { supports_reasoning_effort: true, reasoning_efforts: rungs("xhigh", "high", "medium", "low") }, api_key: "SECRET" },
  "grok-4.5": { info: { supports_reasoning_effort: true, reasoning_efforts: rungs("high", "medium", "low") } },
  "grok-code": { info: { supports_reasoning_effort: false } },
  "grok-odd": { info: { reasoning_efforts: rungs("ultra") } },
};

describe("claude: capabilities.effort of the account catalog", () => {
  it("parses the supported levels in canonical order, [] for a model with none, null when it says nothing", () => {
    expect(parseClaudeEffortCapability({ effort: eff("max", "low", "high") })).toEqual(["low", "high", "max"]);
    expect(parseClaudeEffortCapability({ effort: { supported: false } })).toEqual([]);
    for (const bad of [undefined, null, {}, { effort: null }, { effort: [] }, { effort: "high" }, { effort: { supported: "yes" } }, { effort: { supported: true } }, { effort: eff() }]) {
      expect(parseClaudeEffortCapability(bad)).toBeNull();
    }
  });

  it("parses the real /v1/models capabilities (2026-11-11, Claude Team): Haiku 5.5 takes all five, Haiku 4.5 none, Sonnet 4.6 no xhigh", () => {
    const all = '{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":true},"max":{"supported":true}}';
    expect(parseClaudeEffortCapability({ effort: JSON.parse(all) })).toEqual(["low", "medium", "high", "xhigh", "max"]);   // claude-haiku-5-5
    expect(parseClaudeEffortCapability({ effort: JSON.parse('{"supported":false,"low":{"supported":false},"medium":{"supported":false},"high":{"supported":false},"xhigh":{"supported":false},"max":{"supported":false}}') })).toEqual([]);   // claude-haiku-4-5-20251001
    expect(parseClaudeEffortCapability({ effort: JSON.parse(all.replace('"xhigh":{"supported":true}', '"xhigh":{"supported":false}')) })).toEqual(["low", "medium", "high", "max"]);   // claude-sonnet-4-6
  });

  it("listApiModels keeps max_input_tokens and the effort levels on a model and on its [1m] variant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: API }) })));
    const options = await new ClaudeCodeBackend(root).listApiModels();
    const by = (id: string) => options.find(o => o.id === id)!;
    expect(by("claude-opus-4-6")).toMatchObject({ description: "Claude Opus 4.6", maxInputTokens: 1_000_000, effortLevels: ["low", "medium", "high", "max"] });
    expect(by("claude-opus-4-6[1m]")).toMatchObject({ maxInputTokens: 1_000_000, effortLevels: ["low", "medium", "high", "max"] });
    expect(by("claude-opus-4-5-20251101").maxInputTokens).toBe(200_000);
    expect(by("claude-haiku-4-5-20251001").effortLevels).toEqual([]);
    // an entry without capabilities / tokens adds no keys, so older cache readers see what they always did
    expect(Object.keys(by("claude-legacy-x"))).toEqual(["id", "label", "description"]);
  });

  it("reads the model's levels from the cached catalog; an alias, an unlisted model or no cache is null", () => {
    cliEnv("claude-code", { apiModels: [
      { id: "claude-opus-4-6", label: "claude-opus-4-6", effortLevels: ["low", "medium", "high", "max"] },
      { id: "claude-haiku-4-5-20251001", label: "x", effortLevels: [] },
      { id: "claude-legacy-x", label: "x" },
    ] });
    const home = join(root, "agend");
    expect(readClaudeEffortLevels("claude-opus-4-6", home)).toEqual(["low", "medium", "high", "max"]);
    expect(readClaudeEffortLevels("Claude-Opus-4-6[1m]", home)).toEqual(["low", "medium", "high", "max"]);
    expect(readClaudeEffortLevels("claude-haiku-4-5-20251001", home)).toEqual([]);
    for (const model of ["opus", "default", "sonnet", null, "", "claude-legacy-x", "claude-unlisted"]) expect(readClaudeEffortLevels(model, home)).toBeNull();
    expect(readClaudeEffortLevels("claude-opus-4-6", join(root, "nowhere"))).toBeNull();
  });

  it("a stale cache counts for nothing", () => {
    cliEnv("claude-code", { probedAt: Date.now() - 25 * 3600_000, apiModels: [{ id: "claude-opus-4-6", label: "x", effortLevels: ["low"] }] });
    expect(readClaudeEffortLevels("claude-opus-4-6", join(root, "agend"))).toBeNull();
  });

  it("a credential profile's own catalog first, then the host's", () => {
    cliEnv("claude-code", { apiModels: [{ id: "claude-opus-4-6", label: "x", effortLevels: ["low", "high"] }] });
    cliEnv("claude-code", { apiModels: [{ id: "claude-opus-4-6", label: "x", effortLevels: ["low"] }] }, "claude-code@work");
    const home = join(root, "agend");
    expect(readClaudeEffortLevels("claude-opus-4-6", home, "work")).toEqual(["low"]);
    expect(readClaudeEffortLevels("claude-opus-4-6", home, "other")).toEqual(["low", "high"]);
  });

  it("readEffortMetadata: the model's levels, 'unsupported' for Haiku 4.5, the old five for anything unknown", () => {
    cliEnv("claude-code", { apiModels: [
      { id: "claude-opus-4-6", label: "x", effortLevels: ["low", "medium", "high", "max"] },
      { id: "claude-haiku-4-5-20251001", label: "x", effortLevels: [] },
    ] });
    expect(readEffortMetadata("claude-code", root, "claude-opus-4-6")).toEqual({ strategy: "runtime", levels: ["low", "medium", "high", "max"] });
    expect(readEffortMetadata("claude-code", root, "claude-haiku-4-5-20251001")).toEqual({ strategy: "unsupported", levels: [] });
    const old = { strategy: "runtime", levels: ["low", "medium", "high", "xhigh", "max"] };
    expect(readEffortMetadata("claude-code", root, "opus")).toEqual(old);
    expect(readEffortMetadata("claude-code", root, null)).toEqual(old);
    expect(readEffortMetadata("claude-code", root)).toEqual(old);
    rmSync(join(root, "agend"), { recursive: true });
    expect(readEffortMetadata("claude-code", root, "claude-haiku-4-5-20251001")).toEqual(old);
  });
});

describe("grok: reasoning_efforts of models_cache.json", () => {
  it("reads each model's levels (xhigh on 4.7, not on 4.5), [] for one without, null for what it cannot say", () => {
    grokCache(GROK);
    expect(readGrokEffortLevels("grok-4.7")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(readGrokEffortLevels("GROK-4.5")).toEqual(["low", "medium", "high"]);
    expect(readGrokEffortLevels("grok-code")).toEqual([]);
    for (const model of ["grok-odd", "grok-unlisted", "claude"]) expect(readGrokEffortLevels(model)).toBeNull();
  });

  it("no model: grok's cached default model (the probe's currentModel), else null", () => {
    grokCache(GROK);
    expect(readGrokEffortLevels(null)).toBeNull();
    cliEnv("grok", { currentModel: "grok-4.7" });
    expect(readGrokEffortLevels(null)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("an absent, corrupt, empty, symlinked or oversized cache is null, never an error", () => {
    expect(readGrokEffortLevels("grok-4.7")).toBeNull();
    mkdirSync(join(root, "grok"), { recursive: true });
    const file = join(root, "grok", "models_cache.json");
    writeFileSync(file, "{not json"); expect(readGrokEffortLevels("grok-4.7")).toBeNull();
    writeFileSync(file, ""); expect(readGrokEffortLevels("grok-4.7")).toBeNull();
    writeFileSync(file, JSON.stringify({ models: GROK, pad: "x".repeat(1024 * 1024) })); expect(readGrokEffortLevels("grok-4.7")).toBeNull();
    rmSync(file);
    writeFileSync(join(root, "real.json"), JSON.stringify({ models: GROK }));
    symlinkSync(join(root, "real.json"), file); expect(readGrokEffortLevels("grok-4.7")).toBeNull();
  });

  it("re-reads when grok rewrites the file", () => {
    grokCache(GROK);
    expect(readGrokEffortLevels("grok-4.5")).toEqual(["low", "medium", "high"]);
    grokCache({ ...GROK, "grok-4.5": { info: { reasoning_efforts: rungs("medium") } } });
    const file = join(root, "grok", "models_cache.json");
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(readGrokEffortLevels("grok-4.5")).toEqual(["medium"]);
  });

  it("readEffortMetadata: the model's levels with xhigh, the old three when the cache cannot say", () => {
    grokCache(GROK);
    expect(readEffortMetadata("grok", root, "grok-4.7")).toEqual({ strategy: "runtime", levels: ["low", "medium", "high", "xhigh"] });
    expect(readEffortMetadata("grok", root, "grok-code")).toEqual({ strategy: "unsupported", levels: [] });
    const old = { strategy: "runtime", levels: ["low", "medium", "high"] };
    expect(readEffortMetadata("grok", root, "grok-unlisted")).toEqual(old);
    expect(readEffortMetadata("grok", root, null)).toEqual(old);
    rmSync(join(root, "grok"), { recursive: true });
    expect(readEffortMetadata("grok", root, "grok-4.7")).toEqual(old);
  });

  it("the launch gate takes the model's own levels: xhigh goes out on 4.7, still dropped without them", () => {
    const bin = join(root, "grok");
    writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755); registerExecutableFixture(bin);
    const help = () => "      --reasoning-effort <EFFORT>\n          Reasoning effort\n          [aliases: --effort]\n";
    expect(flagEffort("grok", "xhigh", bin, help, ["low", "medium", "high", "xhigh"])).toMatchObject({ arg: " --reasoning-effort xhigh" });
    expect(flagEffort("grok", "xhigh", bin, help, null).arg).toBeNull();
    expect(flagEffort("grok", "xhigh", bin, help, ["low", "medium", "high"]).arg).toBeNull();
    expect(flagEffort("grok", "medium", bin, help)).toMatchObject({ arg: " --reasoning-effort medium" });
  });
});

describe("grok's fallback model list", () => {
  const dead = () => { const b = new GrokBackend(root); (b as unknown as { binaryPath: string }).binaryPath = join(root, "no-such-grok"); return b; };

  it("is grok's own model cache when the CLI cannot be asked", async () => {
    grokCache({ "grok-4.7": { info: { name: "Grok 4.7" } }, "grok-9": { info: { name: "Grok 9", hidden: true } } });
    expect(await dead().listModels()).toEqual([{ id: "grok-4.7", label: "Grok 4.7" }]);
  });

  it("is today's list (no longer only grok-4.5) when there is no cache either", async () => {
    const models = await dead().listModels();
    expect(models).toEqual(GROK_FALLBACK_MODELS);
    expect(models.map(m => m.id)).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
  });
});

describe("muse's effort in the settings summary", () => {
  it("muse is an effort backend: the summary shows auto, not the dash", () => {
    expect(EFFORT_BACKENDS.has("muse")).toBe(true);
    expect(effectiveSummary({ backend: "muse" }, {}, {}, undefined).effort).toBe("auto");
    expect(effectiveSummary({ backend: "muse" }, { effort: "xhigh" }, {}, undefined).effort).toBe("xhigh");
    expect(effectiveSummary({ backend: "opencode" }, {}, {}, undefined).effort).toBe("—");
  });
});

describe("FleetManager: the running model's levels, and what the chat header is told", { timeout: 60_000 }, () => {
  // The fleet reads AGEND_HOME / GROK_HOME at call time; no CLI, tmux or network starts here.
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
  const catalog = () => cliEnv("claude-code", { apiModels: [
    { id: "claude-opus-4-6", label: "x", effortLevels: ["low", "medium", "high", "max"] },
    { id: "claude-haiku-4-5-20251001", label: "x", effortLevels: [] },
  ] });

  it("claude: effortLevelsFor follows the instance's model; Haiku 4.5 has none, and its strategy is unsupported", async () => {
    catalog();
    const fm = await rig([
      "instances:",
      "  opus: { working_directory: /tmp, backend: claude-code, model: claude-opus-4-6 }",
      "  haiku: { working_directory: /tmp, backend: claude-code, model: claude-haiku-4-5-20251001 }",
      "  alias: { working_directory: /tmp, backend: claude-code, model: opus }",
      "  grokker: { working_directory: /tmp, backend: grok, model: grok-4.7 }",
      "  plain: { working_directory: /tmp, backend: grok }",
    ].join("\n"));
    grokCache(GROK);
    expect(fm.effortLevelsFor("opus")).toEqual(["low", "medium", "high", "max"]);
    expect(fm.effortLevelsFor("haiku")).toEqual([]);
    expect(fm.effortStrategyFor("haiku")).toBe("unsupported");
    expect(fm.effortLevelsFor("alias")).toEqual(["low", "medium", "high", "xhigh", "max"]);   // an alias: the old list
    expect(fm.effortLevelsFor("grokker")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(fm.effortLevelsFor("plain")).toEqual(["low", "medium", "high"]);                  // no model known: the old list
  });

  it("the status frame says whether the effort chip is offered: supported and unset → effort_supported, effort null", async () => {
    catalog();
    const fm = await rig([
      "instances:",
      "  opus: { working_directory: /tmp, backend: claude-code, model: claude-opus-4-6 }",
      "  haiku: { working_directory: /tmp, backend: claude-code, model: claude-haiku-4-5-20251001 }",
      "  set: { working_directory: /tmp, backend: claude-code, model: claude-opus-4-6, effort: high }",
      "  oc: { working_directory: /tmp, backend: opencode }",
    ].join("\n"));
    const frame = (fm.getUiStatus() as { instances: Array<Record<string, unknown>> }).instances;
    const of = (name: string) => frame.find(i => i.name === name);
    expect(of("opus")).toMatchObject({ effort: null, effort_supported: true });
    expect(of("set")).toMatchObject({ effort: "high", effort_supported: true });
    expect(of("haiku")).toMatchObject({ effort: null, effort_supported: false });
    expect(of("oc")).toMatchObject({ effort: null, effort_supported: false });
  });

  it("a /model option's effort (the phone's second level): the model's levels and the set one, none for Haiku 4.5, agy or an unlisted backend", async () => {
    catalog();
    grokCache(GROK);
    const fm = await rig("instances:\n  a: { working_directory: /tmp, backend: claude-code, model: claude-opus-4-6, effort: high }\n");
    const choice = (backend: string, model: string, set: string | null) => fm.modelEffortChoice("a", backend, model, set);
    expect(choice("claude-code", "claude-opus-4-6", "high")).toEqual({ levels: ["low", "medium", "high", "max"], current: "high" });
    expect(choice("claude-code", "claude-opus-4-6", "xhigh")).toEqual({ levels: ["low", "medium", "high", "max"], current: null });   // not a level this model has: auto
    expect(choice("claude-code", "claude-opus-4-6", null)).toEqual({ levels: ["low", "medium", "high", "max"], current: null });
    expect(choice("claude-code", "claude-haiku-4-5-20251001", "high")).toBeNull();
    expect(choice("grok", "grok-4.7", "xhigh")).toEqual({ levels: ["low", "medium", "high", "xhigh"], current: "xhigh" });
    expect(choice("antigravity", "gemini-3.8-flash-high", "high")).toBeNull();
    expect(choice("opencode", "x", "high")).toBeNull();
    expect(choice("codex", "gpt-x", "high")).toBeNull();                                            // codex/kiro: a restart each, not offered here
  });
});
