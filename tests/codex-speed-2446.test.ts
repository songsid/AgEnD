import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_SPEEDS, codexSpeed, isCodexSpeed } from "../src/backend/codex-speed.js";
import { readCodexModelServiceTiers, resetCodexMetadataCache } from "../src/backend/codex-metadata.js";
import { CodexBackend } from "../src/backend/codex.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { normalizeSettingsInstancePatch } from "../src/settings-instance-patch.js";
// @ts-expect-error — a JS module of the app, with no types
import { agentForm, agentPatch, codexSpeedOf } from "../src/ui/settings-model.js";
import { t } from "../src/locale.js";

/**
 * M-2446: a per-agent Codex speed (backend_options.codex.speed: "fast" | "standard"). Unset launches as before; "fast"
 * adds `-c service_tier="fast" -c features.fast_mode=true` only when the running model's catalog entry advertises the
 * "priority" tier (else a quiet note); "standard" adds `-c service_tier="default"`. Allow-listed in the validator; the
 * Settings dialog writes only codex.speed, merged per backend so the agent's other backend options are kept.
 * No real CLI runs here (the request-level proof is the mock-API rig in the PR).
 */
const FAST = ` -c 'service_tier="fast"' -c features.fast_mode=true`;
const STANDARD = ` -c 'service_tier="default"'`;

let root: string;
const saved = { AGEND_HOME: process.env.AGEND_HOME, CODEX_HOME: process.env.CODEX_HOME };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-codex-speed-"));
  process.env.AGEND_HOME = join(root, "agend");
  process.env.CODEX_HOME = join(root, "codex-shared");
  mkdirSync(join(root, "codex-shared"), { recursive: true });
  resetCodexMetadataCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});
const CATALOG = { models: [
  { slug: "gpt-6-sol", supported_reasoning_levels: [{ effort: "high" }], service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }], additional_speed_tiers: ["fast"] },
  { slug: "gpt-daybreak-blue-latest", supported_reasoning_levels: [{ effort: "high" }], service_tiers: [], additional_speed_tiers: [] },
  { slug: "gpt-old", supported_reasoning_levels: [{ effort: "high" }] },
] };
const writeCatalog = () => writeFileSync(join(root, "codex-shared", "models_cache.json"), JSON.stringify(CATALOG));

describe("the speed flags and the allow-list", () => {
  it("unset: nothing; standard: service_tier default whatever the model; fast: both flags only where priority is advertised", () => {
    for (const unset of [undefined, null, ""]) expect(codexSpeed(unset, { model: "gpt-6-sol", tiers: ["priority"] })).toEqual({ arg: null, note: null });
    expect(codexSpeed("standard", { model: "gpt-9", tiers: null })).toEqual({ arg: STANDARD, note: null });
    expect(codexSpeed("standard", { model: null, tiers: null, unproven: true })).toEqual({ arg: STANDARD, note: null });
    expect(codexSpeed("fast", { model: "gpt-6-sol", tiers: ["priority"] })).toEqual({ arg: FAST, note: null });
    expect(codexSpeed("fast", { model: "gpt-daybreak-blue-latest", tiers: [] }))
      .toEqual({ arg: null, note: t("codex.speed_skipped", "fast", t("codex.speed_not_offered", "gpt-daybreak-blue-latest")) });
    expect(codexSpeed("fast", { model: "gpt-9", tiers: null }))
      .toEqual({ arg: null, note: t("codex.speed_skipped", "fast", t("codex.speed_unknown_model", "gpt-9")) });
    expect(codexSpeed("fast", { model: "gpt-6-sol", tiers: ["priority"], unproven: true }))
      .toEqual({ arg: null, note: t("codex.speed_skipped", "fast", t("effort.launch_codex_model_unproven")) });
  });
  it("anything else is refused with a note — codex would silently drop an unknown tier", () => {
    for (const bad of ["priority", "flex", "FAST", "turbo", 1, true]) {
      expect(isCodexSpeed(bad)).toBe(false);
      expect(codexSpeed(bad, { model: "gpt-6-sol", tiers: ["priority"] }))
        .toEqual({ arg: null, note: t("codex.speed_skipped", String(bad), t("codex.speed_not_a_speed", "fast, standard")) });
    }
    expect([...CODEX_SPEEDS]).toEqual(["fast", "standard"]);
  });
});

describe("the catalog gate", () => {
  it("reads the advertised tier ids per model: [] when the entry lists none, null for an unknown model or no cache", () => {
    const homes = { isolatedHome: join(root, "iso"), sharedHome: join(root, "codex-shared") };
    expect(readCodexModelServiceTiers({ ...homes, model: "gpt-6-sol" })).toEqual({ model: "gpt-6-sol", tiers: null });   // no cache yet
    writeCatalog(); resetCodexMetadataCache();
    expect(readCodexModelServiceTiers({ ...homes, model: "gpt-6-sol" })).toEqual({ model: "gpt-6-sol", tiers: ["priority"] });
    expect(readCodexModelServiceTiers({ ...homes, model: "gpt-daybreak-blue-latest" })).toEqual({ model: "gpt-daybreak-blue-latest", tiers: [] });
    expect(readCodexModelServiceTiers({ ...homes, model: "gpt-old" })).toEqual({ model: "gpt-old", tiers: [] });
    expect(readCodexModelServiceTiers({ ...homes, model: "gpt-9" })).toEqual({ model: "gpt-9", tiers: null });
    // No model given: config.toml's model.
    writeFileSync(join(root, "codex-shared", "config.toml"), `model = "gpt-6-sol"\n`);
    expect(readCodexModelServiceTiers(homes)).toEqual({ model: "gpt-6-sol", tiers: ["priority"] });
  });
});

describe("the real builder", () => {
  const instanceDir = () => { const d = join(root, "agend", "instances", "worker"); mkdirSync(d, { recursive: true }); return d; };
  const config = (dir: string, over: Record<string, unknown> = {}) =>
    ({ workingDirectory: dir, instanceDir: dir, instanceName: "worker", mcpServers: {}, ...over }) as never;
  it("fast on a model that offers it: the flags, on a resume too, beside the effort; unset or standard as configured", () => {
    writeCatalog();
    const dir = instanceDir(), b = new CodexBackend(dir);
    (b as any).planResume = () => ({ mode: "resume", id: "019a-thread" });
    const cmd = b.buildCommand(config(dir, { model: "gpt-6-sol", effort: "high", backendOptions: { speed: "fast" } }));
    expect(cmd).toContain("resume '019a-thread'");
    expect(cmd).toContain(FAST);
    expect(cmd).toContain(` -c 'model_reasoning_effort="high"'`);
    expect(b.consumeQuietLaunchNotes()).toEqual([]);
    expect(b.buildCommand(config(dir, { model: "gpt-6-sol" }))).not.toContain("service_tier");                // unset: today's command
    expect(b.buildCommand(config(dir, { model: "gpt-6-sol", backendOptions: { speed: "standard" } }))).toContain(STANDARD);
  });
  it("fast on a model without the tier, or an unknown one: no flag, a quiet note (the effort's note kept beside it)", () => {
    writeCatalog();
    const dir = instanceDir(), b = new CodexBackend(dir);
    const cmd = b.buildCommand(config(dir, { model: "gpt-daybreak-blue-latest", effort: "max", backendOptions: { speed: "fast" } }));
    expect(cmd).not.toContain("service_tier"); expect(cmd).not.toContain("fast_mode");
    expect(b.consumeQuietLaunchNotes()).toEqual([
      t("effort.launch_skipped", "max", "codex", t("effort.launch_level_not_offered", "high")),
      t("codex.speed_skipped", "fast", t("codex.speed_not_offered", "gpt-daybreak-blue-latest")),
    ]);
    expect(b.buildCommand(config(dir, { model: "gpt-9", backendOptions: { speed: "fast" } }))).not.toContain("service_tier");
    expect(b.consumeQuietLaunchNotes()).toEqual([t("codex.speed_skipped", "fast", t("codex.speed_unknown_model", "gpt-9"))]);
  });
  it("an unproven model (a project .codex/config.toml may set another): no Fast flag; standard still applies", () => {
    writeCatalog();
    const dir = instanceDir(), work = join(root, "work");
    mkdirSync(join(work, ".codex"), { recursive: true }); mkdirSync(join(work, ".git"));
    writeFileSync(join(root, "codex-shared", "config.toml"), `model = "gpt-6-sol"\n`);
    writeFileSync(join(work, ".codex", "config.toml"), `model = "gpt-old"\n`);
    const b = new CodexBackend(dir);
    const run = (speed: string) => b.buildCommand({ workingDirectory: work, instanceDir: dir, instanceName: "worker", mcpServers: {}, backendOptions: { speed } } as never);
    expect(run("fast")).not.toContain("service_tier");
    expect(b.consumeQuietLaunchNotes()).toEqual([t("codex.speed_skipped", "fast", t("effort.launch_codex_model_unproven"))]);
    expect(run("standard")).toContain(STANDARD);
  });
});

describe("validation and Settings", () => {
  const fleet = (speed: unknown) => ({ instances: { w: { working_directory: "/tmp/w", backend: "codex", backend_options: { codex: { speed } } } } });
  it("the validator takes fast and standard only", () => {
    for (const ok of ["fast", "standard"]) expect(validateFleetConfig(fleet(ok)).errors.filter((e) => /speed/.test(e.path))).toEqual([]);
    for (const bad of ["priority", "turbo", 2]) {
      expect(validateFleetConfig(fleet(bad)).errors.filter((e) => /speed/.test(e.path)))
        .toEqual([expect.objectContaining({ path: "instances.w.backend_options.codex.speed", message: "must be one of: fast, standard" })]);
    }
  });
  it("a Settings patch merges per backend: other options kept, null removes the key, an empty namespace goes", () => {
    const base = { backend: "codex", backend_options: { codex: { credential_profile: "work", provider: "glm" }, "claude-code": { prompt_cache_ttl: "1h" } } };
    expect(normalizeSettingsInstancePatch(base, { backend_options: { codex: { speed: "fast" } } }).backend_options)
      .toEqual({ codex: { credential_profile: "work", provider: "glm", speed: "fast" }, "claude-code": { prompt_cache_ttl: "1h" } });
    const fast = { backend: "codex", backend_options: { codex: { speed: "fast" } } };
    expect(normalizeSettingsInstancePatch(fast, { backend_options: { codex: { speed: null } } })).toEqual({ backend: "codex" });
    expect(normalizeSettingsInstancePatch({ backend: "codex" }, { backend_options: { codex: { speed: "standard" } } }).backend_options).toEqual({ codex: { speed: "standard" } });
    for (const bad of [null, "fast", ["x"], { codex: "fast" }]) expect(() => normalizeSettingsInstancePatch(base, { backend_options: bad })).toThrow();
  });
  it("the dialog's patch names only codex.speed, and only when it changed", () => {
    const inst = { backend: "codex", working_directory: "/w", backend_options: { codex: { credential_profile: "work" } } };
    const form = agentForm(inst, {}, "w");
    expect(form.codex_speed).toBe("");
    expect(agentPatch(form, inst, {}, null, null)).toEqual({});
    expect(agentPatch({ ...form, codex_speed: "fast" }, inst, {}, null, null)).toEqual({ backend_options: { codex: { speed: "fast" } } });
    const fastInst = { ...inst, backend_options: { codex: { credential_profile: "work", speed: "fast" } } };
    expect(agentForm(fastInst, {}, "w").codex_speed).toBe("fast");
    expect(agentPatch({ ...agentForm(fastInst, {}, "w"), codex_speed: "" }, fastInst, {}, null, null)).toEqual({ backend_options: { codex: { speed: null } } });
    expect(codexSpeedOf({ backend_options: { codex: { speed: "turbo" } } })).toBe("");                   // a typo shows as unset
  });
});
