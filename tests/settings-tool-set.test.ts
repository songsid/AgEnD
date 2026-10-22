/**
 * Settings' tool set picker says what an agent runs under: every profile a person may choose (worker and coordinator
 * were missing), and — while the agent sets none — the profile in effect (the fleet default's, else general for a
 * General, else worker), never the "full" the page used to show. General → Defaults has "not set" as a choice of its
 * own, and choosing it removes the default instead of writing one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { DEFAULT_INSTANCE_CONFIG, loadFleetConfig } from "../src/config.js";
import type { FleetConfig } from "../src/types.js";
import { EventEmitter } from "node:events";
import { handleSettingsRequest } from "../src/settings-api.js";
import { TOOL_PROFILES, resolveToolSet } from "../src/tool-permissions.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
// @ts-expect-error — a JS module of the app, with no types
import { TOOL_SETS, agentForm, agentPatch, toolSetDefault } from "../src/ui/settings-model.js";

describe("the profiles offered", () => {
  it("every profile a person may set — the validator's — and not general, which AgEnD assigns", () => {
    expect([...TOOL_SETS].sort()).toEqual(Object.keys(TOOL_PROFILES).filter((p) => p !== "general").sort());
    const refused = (tool_set: string) => validateFleetConfig({ defaults: {}, instances: { a: { tool_set } } }).errors.some((e) => e.path === "instances.a.tool_set");
    expect(TOOL_SETS.filter(refused)).toEqual([]);
    expect(refused("general")).toBe(true);
  });
});

describe("unset: the profile in effect, as the fleet resolves it", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["dev", {}, {}],
    ["dev", { tool_set: "standard" }, {}],
    ["lead", {}, { general_topic: true }],
    ["general", {}, {}],
    ["lead", { tool_set: "coordinator" }, { general_topic: true }],         // an explicit default wins for a General too
    ["dev", { tool_set: "bogus" }, {}],                                      // not a profile: as if unset
  ];
  it.each(cases)("%s with defaults %j and %j", (name, defaults, inst) => {
    const merged = { ...defaults, ...inst } as { tool_set?: string; general_topic?: boolean };
    expect(toolSetDefault(defaults, inst, name)).toBe(resolveToolSet(merged, name));
  });

  // #2407 review: the role as loaded — the defaults merged under the agent's own — not the agent's raw keys alone.
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const loaded: Array<[string, string]> = [
    ["a role inherited from the defaults", "defaults:\n  general_topic: true\ninstances:\n  dev:\n    working_directory: <DIR>\n"],
    ["control: a default profile", "defaults:\n  general_topic: true\n  tool_set: coordinator\ninstances:\n  dev:\n    working_directory: <DIR>\n"],
    ["control: the agent's own false role", "defaults:\n  general_topic: true\ninstances:\n  dev:\n    working_directory: <DIR>\n    general_topic: false\n"],
    ["control: the agent's own General role", "defaults: {}\ninstances:\n  dev:\n    working_directory: <DIR>\n    general_topic: true\n"],
  ];
  it.each(loaded)("as fleet.yaml loads: %s", (_label, text) => {
    const dir = mkdtempSync(join(tmpdir(), "tool-set-")); dirs.push(dir);
    const file = join(dir, "fleet.yaml");
    writeFileSync(file, text.replaceAll("<DIR>", dir));
    const raw = yaml.load(text) as { defaults: Record<string, unknown>; instances: { dev: Record<string, unknown> } };
    expect(toolSetDefault(raw.defaults, raw.instances.dev, "dev")).toBe(resolveToolSet(loadFleetConfig(file).instances.dev, "dev"));
  });

  it("the agent form: inheriting shows that profile; the value it would write is always one a person may set", () => {
    const worker = agentForm({ working_directory: "/w" }, {}, "dev");
    expect([worker.inherit.tool_set, worker.tool_set]).toEqual([true, "worker"]);
    const general = agentForm({ working_directory: "/w", general_topic: true }, {}, "lead");
    expect(toolSetDefault({}, { general_topic: true }, "lead")).toBe("general");
    expect(TOOL_SETS).toContain(general.tool_set);
    expect(agentForm({ working_directory: "/w" }, { tool_set: "standard" }, "dev").tool_set).toBe("standard");
    expect(agentForm({ working_directory: "/w", tool_set: "coordinator" }, {}, "dev").tool_set).toBe("coordinator");
    // Opening and staging without a change writes nothing (it used to read unset as full).
    const inst = { working_directory: "/w" };
    expect(agentPatch(agentForm(inst, {}, "dev"), inst, {}, null, null)).toEqual({});
  });
});

describe("General → Defaults: not set is a choice, and choosing it removes the default", () => {
  it("the confirmation names the change to the default, and the default goes", () => {
    const config: FleetConfig = { defaults: { tool_set: "full" }, channels: [], instances: { dev: { ...DEFAULT_INSTANCE_CONFIG, working_directory: "/w" } } };
    const { diff } = prepareSettingsEffect("PUT", "/api/settings/fleet/defaults", { tool_set: null }, { config, classic: {} });
    expect(diff?.summary.some((l) => /tool\\?_set/.test(l) && /full/.test(l))).toBe(true);
    expect(validateFleetConfig({ defaults: { tool_set: null }, instances: {} }).errors.map((e) => e.path)).toEqual(["defaults.tool_set"]);
  });

  it("the handler (settings-locale-auto-1310's path): null removes it — a null kept would fail validation", async () => {
    const defaults: Record<string, unknown> = { tool_set: "full", log_level: "info" };
    const ctx = { fleetConfig: { defaults, instances: {} }, getRawFleetConfig: () => ({}), saveFleetConfig: () => {}, logger: { warn: () => {}, info: () => {}, error: () => {} } } as any;
    const put = (body: unknown) => new Promise<number>((resolve) => {
      const req = Object.assign(new EventEmitter(), { method: "PUT", headers: {}, destroy: () => undefined });
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end() { resolve(status); } };
      handleSettingsRequest(req as never, res as never, new URL("http://localhost/api/settings/fleet/defaults"), ctx);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    });
    expect(await put({ tool_set: null })).toBe(200);
    expect(ctx.fleetConfig.defaults).toEqual({ log_level: "info" });
    expect(await put({ tool_set: "coordinator" })).toBe(200);
    expect(ctx.fleetConfig.defaults.tool_set).toBe("coordinator");
  });
});
