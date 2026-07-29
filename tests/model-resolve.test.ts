import { describe, expect, it } from "vitest";

/**
 * Mirrors FleetManager.resolveInstanceModel's precedence so the chain is pinned
 * without standing up a whole FleetManager. Keep in sync with fleet-manager.ts.
 */
type Source = "instance" | "fleet-default" | "classic" | "cli-default" | "unresolved";
function resolve(input: {
  instanceModel?: string;
  fleetDefault?: string;
  isFleetInstance?: boolean;
  classicModel?: string;
  cliEnvExists?: boolean;
  cliCurrentModel?: string;
}): { model: string; source: Source; display: string } {
  const done = (model: string, source: Source, reason?: string) => ({
    model, source,
    display: source === "cli-default" ? `${model} (default)`
      : source === "unresolved" ? `default (${reason ?? "unresolved"})`
      : model,
  });
  if (input.isFleetInstance) {
    if (input.instanceModel?.trim()) return done(input.instanceModel.trim(), "instance");
    if (input.fleetDefault?.trim()) return done(input.fleetDefault.trim(), "fleet-default");
  }
  if (input.classicModel?.trim()) return done(input.classicModel.trim(), "classic");
  if (input.cliCurrentModel?.trim()) return done(input.cliCurrentModel.trim(), "cli-default");
  return done("default", "unresolved", input.cliEnvExists ? "this CLI does not report a default" : "not probed yet");
}

describe("resolveInstanceModel precedence", () => {
  it("per-instance model wins over everything", () => {
    const r = resolve({ isFleetInstance: true, instanceModel: "opus", fleetDefault: "sonnet", cliCurrentModel: "auto" });
    expect(r).toMatchObject({ model: "opus", source: "instance", display: "opus" });
  });

  it("falls back to fleet defaults.model", () => {
    const r = resolve({ isFleetInstance: true, fleetDefault: "sonnet", cliCurrentModel: "auto" });
    expect(r).toMatchObject({ model: "sonnet", source: "fleet-default" });
  });

  it("uses the classic channel override for classic instances", () => {
    const r = resolve({ classicModel: "claude-sonnet-4.6", cliCurrentModel: "auto" });
    expect(r).toMatchObject({ model: "claude-sonnet-4.6", source: "classic" });
  });

  it("resolves the CLI's own default and labels it (default)", () => {
    const r = resolve({ isFleetInstance: true, cliEnvExists: true, cliCurrentModel: "auto" });
    expect(r).toEqual({ model: "auto", source: "cli-default", display: "auto (default)" });
  });

  it("explains an unresolved default when the CLI reports none", () => {
    const r = resolve({ isFleetInstance: true, cliEnvExists: true });
    expect(r.source).toBe("unresolved");
    expect(r.display).toBe("default (this CLI does not report a default)");
  });

  it("explains an unresolved default when no probe has run", () => {
    const r = resolve({ isFleetInstance: true, cliEnvExists: false });
    expect(r.display).toBe("default (not probed yet)");
  });

  it("ignores whitespace-only configured models", () => {
    const r = resolve({ isFleetInstance: true, instanceModel: "   ", fleetDefault: "sonnet" });
    expect(r).toMatchObject({ model: "sonnet", source: "fleet-default" });
  });
});
